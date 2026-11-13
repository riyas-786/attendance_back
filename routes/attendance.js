const express = require('express');
const ExcelJS = require('exceljs');
const Attendance = require('../models/Attendance');
const User = require('../models/User');
const { protect, adminOnly } = require('../middleware/auth');
const { verifyPresence } = require('../utils/presence');
const { resolveRules } = require('../utils/rules');
const {
  MAX_SESSIONS_PER_DAY, normalize, openSession, recompute, secondsToWait, listSessions, detailSessions, placeText, mapUrl, plain,
} = require('../utils/sessions');
const { labelLocation } = require('../utils/place');
const { checkDevice } = require('../utils/device');

const router = express.Router();
router.use(protect);

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeStr = (d) => (d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '');
const hoursStr = (mins) => (mins ? (mins / 60).toFixed(2) : '');

// `rules` comes from resolveRules(): this person's own duty time
function isLate(now, rules) {
  const [h, m] = rules.workStart.split(':').map(Number);
  const limit = new Date(now);
  limit.setHours(h, m + rules.graceMinutes, 0, 0);
  return now > limit;
}

// What the front end needs to know about THIS person's rules (no secrets)
router.get('/rules', async (req, res) => {
  try {
    const rules = await resolveRules(req.user);
    res.json({
      locationRequired: !!rules.sites,
      qrRequired: !!rules.cfg.requireQr,
      workStart: rules.workStart,
      graceMinutes: rules.graceMinutes,
      shiftName: rules.shiftName,
      places: rules.sites ? rules.sites.map((s) => s.name) : [],
    });
  } catch (err) {
    res.status(500).json({ message: 'Could not load rules' });
  }
});

// Today's record for the logged-in user
router.get('/today', async (req, res) => {
  const record = await Attendance.findOne({ user: req.user._id, date: dayKey() });
  res.json(record);
});

// Check in  (body: { note?, lat?, lng?, accuracy?, qrToken? })
router.post('/check-in', async (req, res) => {
  try {
    const dev = await checkDevice(req.user, req.headers['x-device-id']);
    if (!dev.ok) return res.status(dev.status).json({ message: dev.message });

    const rules = await resolveRules(req.user);
    const presence = verifyPresence(req.body, rules.cfg, rules.sites);
    if (!presence.ok) return res.status(presence.status).json({ message: presence.message });

    const now = new Date();
    const date = dayKey(now);
    // An admin may have pre-marked the day as leave/absent; the first check-in overrides it
    const record = normalize((await Attendance.findOne({ user: req.user._id, date })) || new Attendance({ user: req.user._id, date }));

    if (openSession(record)) return res.status(409).json({ message: 'You are already checked in. Check out first.' });
    if (record.sessions.length >= MAX_SESSIONS_PER_DAY) {
      return res.status(409).json({ message: `You can check in at most ${MAX_SESSIONS_PER_DAY} times a day.` });
    }
    const wait = secondsToWait(record, now);
    if (wait > 0) return res.status(429).json({ message: `You just checked out. Please wait ${wait} seconds before checking in again.` });

    // Late is decided by the first check-in of the day only
    const first = record.sessions.length === 0;
    record.sessions.push({ in: now, inLocation: await labelLocation(presence.location, rules.cfg), inMethod: presence.method });
    if (first) record.status = isLate(now, rules) ? 'late' : 'present';
    record.note = req.body.note || record.note || '';
    recompute(record);
    await record.save();
    res.status(201).json(record);
  } catch (err) {
    res.status(500).json({ message: 'Could not check in' });
  }
});

// Check out
router.post('/check-out', async (req, res) => {
  try {
    const dev = await checkDevice(req.user, req.headers['x-device-id']);
    if (!dev.ok) return res.status(dev.status).json({ message: dev.message });

    const rules = await resolveRules(req.user);
    const presence = verifyPresence(req.body, rules.cfg, rules.sites);
    if (!presence.ok) return res.status(presence.status).json({ message: presence.message });

    const now = new Date();
    const found = await Attendance.findOne({ user: req.user._id, date: dayKey(now) });
    if (!found?.checkIn) return res.status(400).json({ message: 'You have not checked in today' });
    const record = normalize(found);

    const open = openSession(record);
    if (!open) return res.status(409).json({ message: 'You are not checked in right now. Check in first.' });
    const wait = secondsToWait(record, now);
    if (wait > 0) return res.status(429).json({ message: `You just checked in. Please wait ${wait} seconds before checking out.` });

    open.out = now;
    open.outLocation = await labelLocation(presence.location, rules.cfg);
    if (req.body.note) record.note = req.body.note;
    recompute(record);
    await record.save();
    res.json(record);
  } catch (err) {
    res.status(500).json({ message: 'Could not check out' });
  }
});

// My history (optional ?from=YYYY-MM-DD&to=YYYY-MM-DD)
router.get('/my', async (req, res) => {
  const { from, to } = req.query;
  const filter = { user: req.user._id };
  if (from || to) filter.date = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
  const records = await Attendance.find(filter).sort({ date: -1 }).limit(366);
  res.json(records);
});

// ---- Admin ----

// All staff attendance (?date=, ?from=&to=, ?userId=, ?status=)
router.get('/', adminOnly, async (req, res) => {
  const { date, from, to, userId, status } = req.query;
  const filter = {};
  if (date) filter.date = date;
  else if (from || to) filter.date = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
  if (userId) filter.user = userId;
  if (status) filter.status = status;

  const records = await Attendance.find(filter)
    .populate('user', 'name email department employeeId')
    .sort({ date: -1, checkIn: 1 })
    .limit(2000);
  res.json(records);
});

// Daily summary: present / late / on leave / not yet in
router.get('/summary', adminOnly, async (req, res) => {
  const date = req.query.date || dayKey();
  const [totalStaff, records] = await Promise.all([
    User.countDocuments({ role: 'staff', active: true }),
    Attendance.find({ date }),
  ]);
  const count = (s) => records.filter((r) => r.status === s).length;
  const present = count('present');
  const late = count('late');
  const leave = count('leave');
  res.json({ date, totalStaff, present, late, leave, notIn: Math.max(totalStaff - present - late - leave, 0) });
});

// ---- Reports ----

async function loadReportRows(query) {
  const now = new Date();
  const from = query.from || `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
  const to = query.to || dayKey(now);
  const filter = { date: { $gte: from, $lte: to } };
  if (query.userId) filter.user = query.userId;

  const records = await Attendance.find(filter).populate('user', 'name email department employeeId');
  records.sort((a, b) => a.date.localeCompare(b.date) || (a.user?.name || '').localeCompare(b.user?.name || ''));
  return { from, to, records };
}

const csvCell = (v) => {
  let s = v === undefined || v === null ? '' : String(v);
  // stop spreadsheet formula injection from user-entered text
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// "08:00-12:00; 13:00-17:30" (a session still open shows "13:00-")
const sessionsText = (r) => listSessions(r).map((s) => `${timeStr(s.in)}-${timeStr(s.out)}`).join('; ');

// Check in = first check-in of the day, Check out = last check-out, Hours = total over all sessions
// Where each session started/ended: "In: Head office (35 m) / Out: Head office (12 m); In: ..."
const placesText = (r) =>
  detailSessions(r)
    .map((s) => `In: ${placeText(s.inLocation, s.inMethod)}${s.out ? ` / Out: ${placeText(s.outLocation, s.inMethod)}` : ''}`)
    .join('; ');

const COLUMNS = ['Date', 'Employee ID', 'Name', 'Department', 'Check in', 'Check out', 'Hours', 'All sessions', 'Places', 'Status', 'Method', 'Note'];
const toRow = (r) => [
  r.date,
  r.user?.employeeId || '',
  r.user?.name || '',
  r.user?.department || '',
  timeStr(r.checkIn),
  timeStr(r.checkOut),
  hoursStr(r.workedMinutes),
  sessionsText(r),
  placesText(r),
  r.status,
  r.checkIn ? r.inMethod : '',
  r.note || '',
];

router.get('/export.csv', adminOnly, async (req, res) => {
  try {
    const { from, to, records } = await loadReportRows(req.query);
    const lines = [COLUMNS, ...records.map(toRow)].map((row) => row.map(csvCell).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="attendance_${from}_to_${to}.csv"`);
    // BOM so Excel opens UTF-8 (Arabic names etc.) correctly
    res.send('﻿' + lines.join('\r\n'));
  } catch (err) {
    res.status(500).json({ message: 'Could not build report' });
  }
});

router.get('/export.xlsx', adminOnly, async (req, res) => {
  try {
    const { from, to, records } = await loadReportRows(req.query);
    const wb = new ExcelJS.Workbook();

    const sheet = wb.addWorksheet('Attendance');
    sheet.addRow(COLUMNS);
    records.forEach((r) => sheet.addRow(toRow(r)));
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9EEFF' } };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    [12, 12, 22, 16, 10, 10, 8, 34, 48, 10, 8, 30].forEach((w, i) => (sheet.getColumn(i + 1).width = w));

    // Per-employee summary
    const by = new Map();
    for (const r of records) {
      const key = String(r.user?._id);
      if (!by.has(key)) by.set(key, { user: r.user, present: 0, late: 0, leave: 0, absent: 0, minutes: 0 });
      const s = by.get(key);
      s[r.status] += 1;
      s.minutes += r.workedMinutes || 0;
    }
    const sum = wb.addWorksheet('Summary');
    sum.addRow(['Employee ID', 'Name', 'Department', 'Present', 'Late', 'Leave', 'Absent', 'Total hours']);
    [...by.values()]
      .sort((a, b) => (a.user?.name || '').localeCompare(b.user?.name || ''))
      .forEach((s) =>
        sum.addRow([
          s.user?.employeeId || '',
          s.user?.name || '',
          s.user?.department || '',
          s.present,
          s.late,
          s.leave,
          s.absent,
          Number((s.minutes / 60).toFixed(2)),
        ])
      );
    sum.getRow(1).font = { bold: true };
    sum.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9EEFF' } };
    [12, 22, 16, 9, 9, 9, 9, 12].forEach((w, i) => (sum.getColumn(i + 1).width = w));

    // One row per check-in/out session with exactly where it happened
    const loc = wb.addWorksheet('Check-in locations');
    loc.addRow([
      'Date', 'Employee ID', 'Name', 'Session', 'Check in', 'Check-in place', 'Distance (m)', 'Latitude', 'Longitude', 'GPS accuracy (m)', 'Map',
      'Check out', 'Check-out place', 'Distance (m)', 'Latitude', 'Longitude', 'GPS accuracy (m)', 'Map',
    ]);
    const cell = (v) => (v === undefined || v === null ? '' : v);
    const link = (l) => (mapUrl(l) ? { text: 'Open map', hyperlink: mapUrl(l) } : '');
    for (const r of records) {
      detailSessions(r).forEach((s, i) => {
        const a = s.inLocation;
        const b = s.out ? s.outLocation : undefined;
        loc.addRow([
          r.date, r.user?.employeeId || '', r.user?.name || '', i + 1,
          timeStr(s.in), placeText(a, s.inMethod), cell(a?.distanceM), cell(a?.lat), cell(a?.lng), cell(a?.accuracy), link(a),
          timeStr(s.out), s.out ? placeText(b, s.inMethod) : '', cell(b?.distanceM), cell(b?.lat), cell(b?.lng), cell(b?.accuracy), link(b),
        ]);
      });
    }
    loc.getRow(1).font = { bold: true };
    loc.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9EEFF' } };
    loc.views = [{ state: 'frozen', ySplit: 1 }];
    [12, 12, 22, 8, 10, 30, 12, 11, 11, 15, 12, 10, 30, 12, 11, 11, 15, 12].forEach((w, i) => (loc.getColumn(i + 1).width = w));
    [11, 18].forEach((c) => loc.getColumn(c).eachCell((c2, n) => { if (n > 1 && c2.value && c2.value.hyperlink) c2.font = { color: { argb: 'FF1F3FB8' }, underline: true }; }));

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="attendance_${from}_to_${to}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ message: 'Could not build report' });
  }
});

// Admin manually creates/corrects a record (e.g. mark leave, or fix a day's check-in/out times).
// To correct times send `sessions: [{ in, out }, ...]` (replaces all of the day's sessions).
// The older `checkIn` / `checkOut` fields still work: they change the first check-in / last check-out.
router.put('/manual', adminOnly, async (req, res) => {
  try {
    const { userId, date, checkIn, checkOut, sessions, status, note, leaveType } = req.body;
    if (!userId || !date) return res.status(400).json({ message: 'userId and date are required' });

    const record = normalize((await Attendance.findOne({ user: userId, date })) || new Attendance({ user: userId, date }));

    if (sessions !== undefined) {
      if (!Array.isArray(sessions) || sessions.length > MAX_SESSIONS_PER_DAY) {
        return res.status(400).json({ message: `Sessions must be a list of at most ${MAX_SESSIONS_PER_DAY}` });
      }
      const before = new Map(record.sessions.map((x) => [new Date(x.in).getTime(), x]));
      const built = [];
      for (const s of sessions) {
        const inAt = new Date(s?.in);
        const outAt = s?.out ? new Date(s.out) : undefined;
        if (Number.isNaN(inAt.getTime()) || (outAt && Number.isNaN(outAt.getTime()))) {
          return res.status(400).json({ message: 'Each session needs a valid check-in time (and a valid check-out time if given)' });
        }
        if (outAt && outAt < inAt) return res.status(400).json({ message: 'A check-out cannot be before its check-in' });
        // a session whose check-in time is unchanged keeps where it happened; anything typed in by the admin is marked as such
        const prev = before.get(inAt.getTime());
        const sameOut = prev && prev.out && outAt && new Date(prev.out).getTime() === outAt.getTime();
        built.push({
          in: inAt,
          out: outAt,
          inMethod: prev ? prev.inMethod : 'admin',
          inLocation: prev ? plain(prev.inLocation) : undefined,
          outLocation: sameOut ? plain(prev.outLocation) : undefined,
        });
      }
      built.sort((a, b) => a.in - b.in);
      for (let i = 0; i < built.length; i++) {
        const next = built[i + 1];
        if (next && (!built[i].out || built[i].out > next.in)) {
          return res.status(400).json({ message: 'Sessions cannot overlap, and only the last one can be left open' });
        }
      }
      record.sessions = built;
    } else if (checkIn !== undefined || checkOut !== undefined) {
      if (checkIn !== undefined) {
        if (!checkIn) record.sessions = [];
        else if (!record.sessions.length) record.sessions.push({ in: new Date(checkIn), inMethod: 'admin' });
        else record.sessions[0].in = new Date(checkIn);
      }
      if (checkOut !== undefined && record.sessions.length) {
        record.sessions[record.sessions.length - 1].out = checkOut ? new Date(checkOut) : undefined;
      }
    }

    if (status) record.status = status;
    if (leaveType && ['annual', 'sick', 'unpaid', 'other'].includes(leaveType)) record.leaveType = leaveType;
    if (note !== undefined) record.note = note;
    recompute(record);
    await record.save();
    res.json(record);
  } catch (err) {
    res.status(400).json({ message: 'Could not save record' });
  }
});

module.exports = router;
