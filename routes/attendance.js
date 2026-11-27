const express = require('express');
const mongoose = require('mongoose');
const ExcelJS = require('exceljs');
const Attendance = require('../models/Attendance');
const User = require('../models/User');
const { protect, adminOnly, allow } = require('../middleware/auth');
const { verifyPresence } = require('../utils/presence');
const { resolveRules } = require('../utils/rules');
const {
  MAX_SESSIONS_PER_DAY, normalize, openSession, recompute, secondsToWait, listSessions, detailSessions, placeText, mapUrl, plain,
} = require('../utils/sessions');
const { labelLocation } = require('../utils/place');
const { checkDevice } = require('../utils/device');
const { getSettings } = require('../utils/settings');
const { payrollCfg, workingDaysIn, isOffDay } = require('../utils/payroll');
const { isRealDate, datesBetween } = require('../utils/period');

const router = express.Router();
router.use(protect);

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// 24-hour "17:30" by default, or 12-hour "5:30 PM" when h12 is true (reports: ?timeFormat=12)
const timeStr = (d, h12 = false) => {
  if (!d) return '';
  if (!h12) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getHours() % 12 || 12}:${pad(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
};
const wants12h = (req) => String(req.query.timeFormat || '') === '12';
const hoursStr = (mins) => (mins ? (mins / 60).toFixed(2) : '');

// `rules` comes from resolveRules(): this person's own duty time
function isLate(now, rules) {
  if (rules.overnight) {
    // e.g. 21:00 to 07:00: arriving after midnight (before the shift ends) is late for the shift that started yesterday
    const mins = now.getHours() * 60 + now.getMinutes();
    const end = Number(rules.workEnd.slice(0, 2)) * 60 + Number(rules.workEnd.slice(3, 5));
    if (mins < end) return true;
    const start = Number(rules.workStart.slice(0, 2)) * 60 + Number(rules.workStart.slice(3, 5));
    return mins > start + rules.graceMinutes;
  }
  const [h, m] = rules.workStart.split(':').map(Number);
  const limit = new Date(now);
  limit.setHours(h, m + rules.graceMinutes, 0, 0);
  return now > limit;
}

// A shift that runs past midnight belongs to the day it STARTED: arriving at 00:30 for a 21:00 shift counts for yesterday.
function attendanceDate(now, rules) {
  if (rules.overnight) {
    const end = Number(rules.workEnd.slice(0, 2)) * 60 + Number(rules.workEnd.slice(3, 5));
    if (now.getHours() * 60 + now.getMinutes() < end) return dayKey(new Date(now.getTime() - 24 * 3600 * 1000));
  }
  return dayKey(now);
}

// The record with a check-in that has no check-out yet (today's, or yesterday's for a shift that ran past midnight).
// Only counts when it started within the last 16 hours, so a forgotten check-out from yesterday never blocks today.
const MAX_OPEN_HOURS = 16;
async function findOpenRecord(userId, now) {
  const dates = [dayKey(now), dayKey(new Date(now.getTime() - 24 * 3600 * 1000))];
  const recs = await Attendance.find({ user: userId, date: { $in: dates } });
  for (const rec of recs.sort((a, b) => (a.date < b.date ? 1 : -1))) {
    const open = openSession(normalize(rec));
    if (open && now - open.in < MAX_OPEN_HOURS * 3600 * 1000) return rec;
  }
  return null;
}

// What the front end needs to know about THIS person's rules (no secrets)
// The pay period that contains today and the one before it (from Settings -> Pay period starts on day).
// Reports, Working hours and My attendance start on these dates, so every screen uses the same period.
router.get('/pay-period', async (req, res) => {
  try {
    const { monthPeriod, currentKey } = require('../utils/period');
    const startDay = (await getSettings()).payrollStartDay;
    const today = dayKey();
    const key = currentKey(today, startDay);
    const [y, m] = key.split('-').map(Number);
    const prevKey = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
    const cur = monthPeriod(key, startDay);
    const prev = monthPeriod(prevKey, startDay);
    res.json({
      startDay, today, custom: Number(startDay) > 1,
      current: { key, from: cur.from, to: cur.to },
      previous: { key: prevKey, from: prev.from, to: prev.to },
    });
  } catch (err) {
    res.status(500).json({ message: 'Could not load the pay period' });
  }
});

router.get('/rules', async (req, res) => {
  try {
    const rules = await resolveRules(req.user);
    res.json({
      locationRequired: !!rules.sites,
      workStart: rules.workStart,
      workEnd: rules.workEnd,
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
  if (req.user.role === 'admin') return res.json(null);
  // someone still on a night shift that began yesterday gets yesterday's record, so they can check out
  const open = await findOpenRecord(req.user._id, new Date());
  res.json(open || (await Attendance.findOne({ user: req.user._id, date: dayKey() })));
});

// Check in  (body: { note?, lat?, lng?, accuracy? })
router.post('/check-in', async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ message: 'Admin accounts do not check in or out' });
    const dev = await checkDevice(req.user, req.headers['x-device-id']);
    if (!dev.ok) return res.status(dev.status).json({ message: dev.message });

    const rules = await resolveRules(req.user);
    const presence = verifyPresence(req.body, rules.cfg, rules.sites);
    if (!presence.ok) return res.status(presence.status).json({ message: presence.message });

    const now = new Date();
    if (await findOpenRecord(req.user._id, now)) return res.status(409).json({ message: 'You are already checked in. Check out first.' });
    const date = attendanceDate(now, rules);
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
    // a half-day leave / absence keeps its status when the person comes in for the other half
    const keepHalf = record.halfDay && ['leave', 'absent'].includes(record.status);
    if (first && !keepHalf) record.status = isLate(now, rules) ? 'late' : 'present';
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
    if (req.user.role === 'admin') return res.status(403).json({ message: 'Admin accounts do not check in or out' });
    const dev = await checkDevice(req.user, req.headers['x-device-id']);
    if (!dev.ok) return res.status(dev.status).json({ message: dev.message });

    const rules = await resolveRules(req.user);
    const presence = verifyPresence(req.body, rules.cfg, rules.sites);
    if (!presence.ok) return res.status(presence.status).json({ message: presence.message });

    const now = new Date();
    const found = (await findOpenRecord(req.user._id, now)) || (await Attendance.findOne({ user: req.user._id, date: dayKey(now) }));
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
router.get('/', allow('attendance_view', 'attendance_edit'), async (req, res) => {
  const { date, from, to, userId, status } = req.query;
  const filter = {};
  if (date) filter.date = date;
  else if (from || to) filter.date = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
  // only employees: records an admin account made earlier are not part of attendance
  const staffIds = (await User.find({ role: 'staff' }).select('_id')).map((u) => u._id);
  filter.user = userId ? userId : { $in: staffIds };
  if (status) filter.status = status;

  const records = await Attendance.find(filter)
    .populate('user', 'name email department employeeId')
    .sort({ date: -1, checkIn: 1 })
    .limit(2000);
  res.json(records);
});

// Owner view (read-only; also open to admins): who is in, late, on leave or not in on one day.
// Deliberately minimal: names, status, times and hours only. No places, notes, emails or pay.
router.get('/owner', async (req, res) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') return res.status(403).json({ message: 'Owner access required' });
    const date = req.query.date || dayKey();
    if (!isRealDate(date)) return res.status(400).json({ message: 'Date must be YYYY-MM-DD' });

    const staff = await User.find({ role: 'staff', active: true }).select('name department').sort({ name: 1 });
    const records = await Attendance.find({ date, user: { $in: staff.map((u) => u._id) } });
    const byUser = new Map(records.map((r) => [String(r.user), r]));

    const people = staff.map((u) => {
      const r = byUser.get(String(u._id));
      return {
        id: String(u._id),
        name: u.name,
        department: u.department || '',
        status: r ? r.status : 'not in',
        half: !!(r && r.halfDay && ['leave', 'absent'].includes(r.status)),
        sessions: r ? listSessions(r).map((s) => ({ in: s.in, out: s.out || null })) : [],
        workedMinutes: r?.workedMinutes || 0,
      };
    });
    const count = (s) => people.filter((p) => p.status === s).length;
    res.json({
      date,
      counts: { total: people.length, present: count('present'), late: count('late'), leave: count('leave'), absent: count('absent'), notIn: count('not in') },
      people,
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Daily summary: present / late / on leave / not yet in
router.get('/summary', allow('attendance_view', 'attendance_edit'), async (req, res) => {
  const date = req.query.date || dayKey();
  // only people who are on the staff list today: records of removed or admin accounts must not hide a missing person
  const staffIds = (await User.find({ role: 'staff', active: true }).select('_id')).map((u) => u._id);
  const totalStaff = staffIds.length;
  const records = await Attendance.find({ date, user: { $in: staffIds } });
  const count = (s) => records.filter((r) => r.status === s).length;
  const present = count('present');
  const late = count('late');
  const leave = count('leave');
  res.json({ date, totalStaff, present, late, leave, notIn: Math.max(totalStaff - present - late - leave, 0) });
});

// ---- Reports ----

const STATUSES = ['present', 'late', 'leave', 'absent'];

class BadFilter extends Error {}

/**
 * Report filters (all optional, all combine):
 *   from, to        date range (YYYY-MM-DD)
 *   userId          one employee
 *   department      exact department name
 *   shift           shift id
 *   status          comma list of present,late,leave,absent
 *   place           a saved location name, or "__none__" = check-ins that were not at any saved place
 *   includeAbsent   "true" = also list working days with no record at all as absent (active staff, up to yesterday)
 */
async function loadReportRows(query) {
  const now = new Date();
  const from = query.from || `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
  const to = query.to || dayKey(now);
  if (!isRealDate(from) || !isRealDate(to)) throw new BadFilter('From and to must be dates (YYYY-MM-DD)');
  if (from > to) throw new BadFilter('The From date must not be after the To date');
  const filter = { date: { $gte: from, $lte: to } };

  const isId = (v) => mongoose.isValidObjectId(String(v));
  if (query.userId && !isId(query.userId)) throw new BadFilter('Invalid staff member');
  if (query.shift && !isId(query.shift)) throw new BadFilter('Invalid shift');

  // who: employee / department / shift narrow down the list of people
  let userIds = null;
  if (query.userId) userIds = [String(query.userId)];
  if (query.department || query.shift) {
    const who = {};
    if (query.department) who.department = String(query.department);
    if (query.shift) who.shift = query.shift;
    const ids = (await User.find(who).select('_id')).map((u) => String(u._id));
    userIds = userIds ? userIds.filter((id) => ids.includes(id)) : ids;
  }
  if (!userIds) userIds = (await User.find({ role: 'staff' }).select('_id')).map((u) => String(u._id)); // employees only
  filter.user = { $in: userIds };

  const statuses = String(query.status || '').split(',').map((x) => x.trim()).filter((x) => STATUSES.includes(x));
  if (statuses.length) filter.status = { $in: statuses };

  let records = await Attendance.find(filter).populate('user', 'name email department employeeId');

  // working days where someone has no record at all count as absent
  if (String(query.includeAbsent) === 'true' && (!statuses.length || statuses.includes('absent'))) {
    const cfg = payrollCfg(await getSettings());
    const staffFilter = { role: 'staff', active: true };
    if (userIds) staffFilter._id = { $in: userIds };
    const staff = await User.find(staffFilter);
    const today = dayKey(now);
    const days = workingDaysIn(from, to, cfg).filter((d) => d < today); // today may still be checked in
    // a day counts as "has a record" whatever its status, so look at all records, not just the filtered ones
    const base = { date: { $gte: from, $lte: to } };
    if (userIds) base.user = { $in: userIds };
    const existing = statuses.length ? await Attendance.find(base).select('user date') : records;
    const have = new Set(existing.map((r) => `${String(r.user?._id || r.user)}|${r.date}`));
    for (const u of staff) {
      for (const d of days) {
        if (u.joinDate && d < u.joinDate) continue;
        if (have.has(`${String(u._id)}|${d}`)) continue;
        records.push({ date: d, user: u, status: 'absent', sessions: [], workedMinutes: 0, note: 'No record (absent)' });
      }
    }
  }

  if (query.place) {
    records = records.filter((r) => {
      const names = detailSessions(r).flatMap((x) => [x.inLocation?.siteName, x.out ? x.outLocation?.siteName : undefined]).filter(Boolean);
      return query.place === '__none__' ? !!r.checkIn && names.length === 0 : names.includes(String(query.place));
    });
  }

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
const sessionsText = (r, h12 = false) => listSessions(r).map((s) => `${timeStr(s.in, h12)}-${timeStr(s.out, h12)}${s.outMethod === 'auto' ? ' (auto)' : ''}`).join('; ');

// Check in = first check-in of the day, Check out = last check-out, Hours = total over all sessions
// Where each session started/ended: "In: Head office (35 m) / Out: Head office (12 m); In: ..."
const placesText = (r) =>
  detailSessions(r)
    .map((s) => `In: ${placeText(s.inLocation, s.inMethod)}${s.out ? ` / Out: ${placeText(s.outLocation, s.inMethod)}` : ''}`)
    .join('; ');

const COLUMNS = ['Date', 'Employee ID', 'Name', 'Department', 'Check in', 'Check out', 'Hours', 'All sessions', 'Places', 'Status', 'Leave type', 'Method', 'Note'];
const toRow = (r, h12 = false) => [
  r.date,
  r.user?.employeeId || '',
  r.user?.name || '',
  r.user?.department || '',
  timeStr(r.checkIn, h12),
  timeStr(r.checkOut, h12),
  hoursStr(r.workedMinutes),
  sessionsText(r, h12),
  placesText(r),
  r.status + (r.halfDay && ['leave', 'absent'].includes(r.status) ? ' (half day)' : '') + (r.otStatus ? ` (OT ${r.otStatus})` : ''),
  r.status === 'leave' ? (r.leaveType === 'unpaid' ? 'Unpaid' : 'Paid') + (r.leaveType && r.leaveType !== 'unpaid' ? ` (${r.leaveType})` : '') : '',
  r.checkIn ? r.inMethod : '',
  r.note || '',
];

router.get('/export.csv', allow('reports'), async (req, res) => {
  try {
    const { from, to, records } = await loadReportRows(req.query);
    const lines = [COLUMNS, ...records.map((r) => toRow(r, wants12h(req)))].map((row) => row.map(csvCell).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="attendance_${from}_to_${to}.csv"`);
    // BOM so Excel opens UTF-8 (Arabic names etc.) correctly
    res.send('﻿' + lines.join('\r\n'));
  } catch (err) {
    if (err instanceof BadFilter) return res.status(400).json({ message: err.message });
    res.status(500).json({ message: 'Could not build report' });
  }
});

// The same rows as the downloads, as JSON, so the Reports page can preview what the filters match
router.get('/report', allow('reports'), async (req, res) => {
  try {
    const { from, to, records } = await loadReportRows(req.query);
    const LIMIT = 500;
    const counts = { present: 0, late: 0, leave: 0, absent: 0 };
    let minutes = 0;
    for (const r of records) {
      if (counts[r.status] !== undefined) counts[r.status] += 1;
      minutes += r.workedMinutes || 0;
    }
    res.json({ from, to, total: records.length, counts, hours: Number((minutes / 60).toFixed(2)), columns: COLUMNS, rows: records.slice(0, LIMIT).map((r) => toRow(r, wants12h(req))), limit: LIMIT });
  } catch (err) {
    if (err instanceof BadFilter) return res.status(400).json({ message: err.message });
    res.status(500).json({ message: 'Could not build report' });
  }
});

router.get('/export.xlsx', allow('reports'), async (req, res) => {
  try {
    const { from, to, records } = await loadReportRows(req.query);
    const wb = new ExcelJS.Workbook();

    const sheet = wb.addWorksheet('Attendance');
    sheet.addRow(COLUMNS);
    records.forEach((r) => sheet.addRow(toRow(r, wants12h(req))));
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9EEFF' } };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    [12, 12, 22, 16, 10, 10, 8, 34, 48, 10, 14, 8, 30].forEach((w, i) => (sheet.getColumn(i + 1).width = w));

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
          timeStr(s.in, wants12h(req)), placeText(a, s.inMethod), cell(a?.distanceM), cell(a?.lat), cell(a?.lng), cell(a?.accuracy), link(a),
          timeStr(s.out, wants12h(req)), s.out ? placeText(b, s.inMethod) : '', cell(b?.distanceM), cell(b?.lat), cell(b?.lng), cell(b?.accuracy), link(b),
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
    if (!res.headersSent) {
      if (err instanceof BadFilter) return res.status(400).json({ message: err.message });
      res.status(500).json({ message: 'Could not build report' });
    }
  }
});

// Admin manually creates/corrects a record (e.g. mark leave, or fix a day's check-in/out times).
// To correct times send `sessions: [{ in, out }, ...]` (replaces all of the day's sessions).
// The older `checkIn` / `checkOut` fields still work: they change the first check-in / last check-out.
router.put('/manual', allow('attendance_edit'), async (req, res) => {
  try {
    const { userId, date, checkIn, checkOut, sessions, status, note, leaveType, halfDay } = req.body;
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
          // a check-out time typed in by an admin is marked as such; an unchanged one keeps how it was made
          outMethod: sameOut ? prev.outMethod : outAt ? 'admin' : undefined,
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
    // a day the system filled in for an auto-attendance person: marking it leave / absent removes the automatic hours
    if (record.auto && sessions === undefined && checkIn === undefined && checkOut === undefined && ['leave', 'absent'].includes(record.status) && record.sessions.every((x) => x.inMethod === 'auto')) {
      record.sessions = [];
      record.auto = false;
    }
    if (leaveType && ['annual', 'sick', 'unpaid', 'other'].includes(leaveType)) record.leaveType = leaveType;
    if (halfDay !== undefined) {
      if (halfDay && !(await getSettings()).halfDayEnabled) return res.status(400).json({ message: 'Half days are switched off in Settings' });
      record.halfDay = !!halfDay;
    }
    // a half day only makes sense for leave or absence
    if (record.halfDay && !['leave', 'absent'].includes(record.status)) record.halfDay = false;
    if (note !== undefined) record.note = note;
    recompute(record);
    await record.save();
    res.json(record);
  } catch (err) {
    res.status(400).json({ message: 'Could not save record' });
  }
});

// ---- Working hours of every staff member for a period (who worked how many hours) ----
const hhmmToMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

async function buildHours(query) {
  const from = String(query.from || '');
  const to = String(query.to || '');
  if (!isRealDate(from) || !isRealDate(to)) throw new BadFilter('From and to must be dates (YYYY-MM-DD)');
  if (from > to) throw new BadFilter('The From date must not be after the To date');
  if (datesBetween(from, to).length > 366) throw new BadFilter('Choose at most one year');

  const cfg = await getSettings();
  const workingDays = workingDaysIn(from, to, payrollCfg(cfg));
  const today = dayKey();

  const staff = await User.find({ role: 'staff', active: true }).populate('shift', 'workStart workEnd').select('name employeeId department shift joinDate').sort({ name: 1 });
  const records = await Attendance.find({ date: { $gte: from, $lte: to }, user: { $in: staff.map((u) => u._id) } });
  const byUser = new Map();
  for (const r of records) {
    const k = String(r.user);
    if (!byUser.has(k)) byUser.set(k, []);
    byUser.get(k).push(r);
  }

  const rows = staff.map((u) => {
    const recs = (byUser.get(String(u._id)) || []).sort((a, b) => a.date.localeCompare(b.date));
    const days = [];
    let total = 0;
    let withHours = 0;
    let longest = 0;
    let late = 0;
    let open = 0;
    for (const r of recs) {
      normalize(r);
      const sess = listSessions(r);
      if (!sess.length) continue; // a leave / absence mark without any check-in
      const minutes = r.workedMinutes || 0;
      const last = sess[sess.length - 1];
      const isOpen = !last.out;
      days.push({
        date: r.date, minutes, in: sess[0].in, out: isOpen ? null : last.out, sessions: sess.length,
        status: r.status, open: isOpen, auto: sess.some((x) => x.outMethod === 'auto'),
      });
      total += minutes;
      if (minutes > 0) withHours += 1;
      if (minutes > longest) longest = minutes;
      if (r.status === 'late') late += 1;
      if (isOpen) open += 1;
    }
    // hours they should have worked: working days so far x the length of their shift (only when they have a shift with an end time)
    const s = u.shift;
    const perDay = s && s.workEnd && hhmmToMin(s.workEnd) > hhmmToMin(s.workStart) ? hhmmToMin(s.workEnd) - hhmmToMin(s.workStart) : null;
    const due = workingDays.filter((d) => d <= today && (!u.joinDate || d >= u.joinDate)).length;
    const expected = perDay === null ? null : perDay * due;
    return {
      userId: String(u._id), name: u.name, employeeId: u.employeeId || '', department: u.department || '',
      daysPresent: days.length, totalMinutes: total, avgMinutes: withHours ? Math.round(total / withHours) : 0,
      longestMinutes: longest, lateDays: late, openDays: open,
      expectedMinutes: expected, diffMinutes: expected === null ? null : total - expected,
      days,
    };
  });

  const totalMinutes = rows.reduce((t, r) => t + r.totalMinutes, 0);
  return {
    from, to, workingDays: workingDays.length, rows,
    totals: { staff: rows.length, totalMinutes, avgMinutesPerStaff: rows.length ? Math.round(totalMinutes / rows.length) : 0, openDays: rows.reduce((t, r) => t + r.openDays, 0) },
  };
}

router.get('/hours', allow('reports', 'attendance_view', 'attendance_edit'), async (req, res) => {
  try {
    res.json(await buildHours(req.query));
  } catch (err) {
    if (err instanceof BadFilter) return res.status(400).json({ message: err.message });
    res.status(500).json({ message: 'Could not work out the hours' });
  }
});

router.get('/hours.xlsx', allow('reports', 'attendance_view', 'attendance_edit'), async (req, res) => {
  try {
    const d = await buildHours(req.query);
    const h = (m) => Math.round((m / 60) * 100) / 100;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Hours per person', { views: [{ state: 'frozen', ySplit: 3 }] });
    ws.mergeCells('A1:K1');
    ws.getCell('A1').value = `Working hours  ·  ${d.from} to ${d.to}  ·  ${d.workingDays} working days`;
    ws.getCell('A1').font = { bold: true, size: 14 };
    const heads = ['Employee ID', 'Name', 'Department', 'Days present', 'Total hours', 'Average hours / day', 'Longest day (h)', 'Expected hours', 'Over / under (h)', 'Late days', 'Days without check-out'];
    ws.getRow(3).values = heads;
    ws.getRow(3).eachCell((c) => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } }; c.alignment = { wrapText: true, vertical: 'middle' }; });
    [13, 24, 16, 12, 12, 14, 14, 14, 14, 10, 14].forEach((w, i) => (ws.getColumn(i + 1).width = w));
    d.rows.forEach((r) => ws.addRow([r.employeeId, r.name, r.department, r.daysPresent, h(r.totalMinutes), h(r.avgMinutes), h(r.longestMinutes), r.expectedMinutes === null ? '' : h(r.expectedMinutes), r.diffMinutes === null ? '' : h(r.diffMinutes), r.lateDays, r.openDays]));
    const last = d.rows.length + 3;
    const tot = ws.addRow(['', 'TOTAL', '', { formula: `SUM(D4:D${last})`, result: d.rows.reduce((t, r) => t + r.daysPresent, 0) }, { formula: `SUM(E4:E${last})`, result: h(d.totals.totalMinutes) }, '', '', '', '', { formula: `SUM(J4:J${last})`, result: d.rows.reduce((t, r) => t + r.lateDays, 0) }, { formula: `SUM(K4:K${last})`, result: d.totals.openDays }]);
    tot.font = { bold: true };
    for (let i = 4; i <= last + 1; i++) [5, 6, 7, 8, 9].forEach((c) => (ws.getRow(i).getCell(c).numFmt = '0.00'));

    const dd = wb.addWorksheet('Day by day', { views: [{ state: 'frozen', ySplit: 1 }] });
    dd.addRow(['Date', 'Employee ID', 'Name', 'Check in', 'Check out', 'Hours', 'Status', 'Note']);
    dd.getRow(1).eachCell((c) => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } }; });
    [12, 13, 24, 11, 11, 9, 10, 30].forEach((w, i) => (dd.getColumn(i + 1).width = w));
    const h12 = String(req.query.timeFormat || '') === '12';
    d.rows.forEach((r) => r.days.forEach((x) => dd.addRow([
      x.date, r.employeeId, r.name, timeStr(x.in ? new Date(x.in) : null, h12), x.out ? timeStr(new Date(x.out), h12) : '', h(x.minutes), x.status,
      x.open ? 'No check-out yet' : x.auto ? 'Check-out closed automatically' : '',
    ])));
    for (let i = 2; i <= dd.rowCount; i++) dd.getRow(i).getCell(6).numFmt = '0.00';
    dd.autoFilter = { from: 'A1', to: 'H1' };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="working_hours_${d.from}_to_${d.to}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    if (err instanceof BadFilter) return res.status(400).json({ message: err.message });
    res.status(500).json({ message: 'Could not build the hours file' });
  }
});

// Admin decides about attendance on a weekend / holiday:
//   accepted = paid as overtime at a % of the day's pay (default 100), rejected = not paid, pending = decide later.
router.post('/ot', allow('attendance_edit'), async (req, res) => {
  try {
    const { userId, date, decision } = req.body || {};
    if (!userId || !isRealDate(date)) return res.status(400).json({ message: 'userId and a valid date are required' });
    if (!['accepted', 'rejected', 'pending'].includes(decision)) return res.status(400).json({ message: 'Decision must be accepted, rejected or pending' });
    const cfg = payrollCfg(await getSettings());
    if (!isOffDay(date, cfg)) return res.status(400).json({ message: 'That day is a normal working day, there is nothing to accept as OT' });
    const record = await Attendance.findOne({ user: userId, date });
    if (!record || !(record.checkIn || (record.sessions && record.sessions.length))) return res.status(404).json({ message: 'There is no attendance on that day' });
    if (['leave', 'absent'].includes(record.status)) return res.status(400).json({ message: 'That day is marked as leave / absence' });
    record.otStatus = decision === 'pending' ? '' : decision;
    // accepted at this % of the day's pay (default 100)
    let percent = 100;
    if (decision === 'accepted' && req.body.percent !== undefined && req.body.percent !== '') {
      percent = Number(req.body.percent);
      if (!Number.isFinite(percent) || percent < 1 || percent > 100) return res.status(400).json({ message: 'Percentage must be between 1 and 100' });
      percent = Math.round(percent * 100) / 100;
    }
    record.otPercent = percent;
    await record.save();
    res.json({ otStatus: record.otStatus, otPercent: record.otPercent });
  } catch (err) {
    res.status(400).json({ message: 'Could not save the decision' });
  }
});

// Admin removes a leave / absence mark (full or half day), putting the day back as it was.
// No check-ins that day: the record is deleted (the day has "no record" again).
// The person did check in: the day goes back to present / late, based on their first check-in.
router.post('/manual/clear', allow('attendance_edit'), async (req, res) => {
  try {
    const { userId, date } = req.body;
    if (!userId || !isRealDate(date)) return res.status(400).json({ message: 'userId and a valid date are required' });
    const found = await Attendance.findOne({ user: userId, date });
    if (!found) return res.status(404).json({ message: 'Nothing to clear: there is no record for that day' });
    const record = normalize(found);
    if (!['leave', 'absent'].includes(record.status)) return res.status(400).json({ message: 'No leave or absence is marked on that day' });

    if (!record.sessions.length) {
      await record.deleteOne();
      return res.json({ cleared: true, removed: true });
    }
    const person = await User.findById(userId);
    const rules = await resolveRules(person);
    record.status = isLate(record.sessions[0].in, rules) ? 'late' : 'present';
    record.halfDay = false;
    recompute(record);
    await record.save();
    res.json({ cleared: true, removed: false, status: record.status });
  } catch (err) {
    res.status(400).json({ message: 'Could not clear the mark' });
  }
});

module.exports = router;
