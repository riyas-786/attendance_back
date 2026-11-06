const express = require('express');
const ExcelJS = require('exceljs');
const Attendance = require('../models/Attendance');
const User = require('../models/User');
const { protect, adminOnly } = require('../middleware/auth');
const { verifyPresence } = require('../utils/presence');
const { resolveRules } = require('../utils/rules');

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
    const rules = await resolveRules(req.user);
    const presence = verifyPresence(req.body, rules.cfg, rules.sites);
    if (!presence.ok) return res.status(presence.status).json({ message: presence.message });

    const now = new Date();
    const date = dayKey(now);
    const existing = await Attendance.findOne({ user: req.user._id, date });
    if (existing?.checkIn) return res.status(409).json({ message: 'Already checked in today' });

    // An admin may have pre-marked the day as leave/absent; checking in overrides it
    const record = existing || new Attendance({ user: req.user._id, date });
    record.checkIn = now;
    record.status = isLate(now, rules) ? 'late' : 'present';
    record.note = req.body.note || record.note || '';
    record.inLocation = presence.location;
    record.inMethod = presence.method;
    await record.save();
    res.status(201).json(record);
  } catch (err) {
    res.status(500).json({ message: 'Could not check in' });
  }
});

// Check out
router.post('/check-out', async (req, res) => {
  try {
    const rules = await resolveRules(req.user);
    const presence = verifyPresence(req.body, rules.cfg, rules.sites);
    if (!presence.ok) return res.status(presence.status).json({ message: presence.message });

    const now = new Date();
    const record = await Attendance.findOne({ user: req.user._id, date: dayKey(now) });
    if (!record?.checkIn) return res.status(400).json({ message: 'You have not checked in today' });
    if (record.checkOut) return res.status(409).json({ message: 'Already checked out today' });

    record.checkOut = now;
    record.workedMinutes = Math.round((now - record.checkIn) / 60000);
    record.outLocation = presence.location;
    if (req.body.note) record.note = req.body.note;
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

const COLUMNS = ['Date', 'Employee ID', 'Name', 'Department', 'Check in', 'Check out', 'Hours', 'Status', 'Method', 'Note'];
const toRow = (r) => [
  r.date,
  r.user?.employeeId || '',
  r.user?.name || '',
  r.user?.department || '',
  timeStr(r.checkIn),
  timeStr(r.checkOut),
  hoursStr(r.workedMinutes),
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
    [12, 12, 22, 16, 10, 10, 8, 10, 8, 30].forEach((w, i) => (sheet.getColumn(i + 1).width = w));

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

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="attendance_${from}_to_${to}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ message: 'Could not build report' });
  }
});

// Admin manually creates/corrects a record (e.g. mark leave or fix a missed check-out)
router.put('/manual', adminOnly, async (req, res) => {
  try {
    const { userId, date, checkIn, checkOut, status, note, leaveType } = req.body;
    if (!userId || !date) return res.status(400).json({ message: 'userId and date are required' });

    const record = (await Attendance.findOne({ user: userId, date })) || new Attendance({ user: userId, date });
    if (checkIn !== undefined) record.checkIn = checkIn ? new Date(checkIn) : undefined;
    if (checkOut !== undefined) record.checkOut = checkOut ? new Date(checkOut) : undefined;
    if (status) record.status = status;
    if (leaveType && ['annual', 'sick', 'unpaid', 'other'].includes(leaveType)) record.leaveType = leaveType;
    if (note !== undefined) record.note = note;
    record.workedMinutes =
      record.checkIn && record.checkOut ? Math.round((record.checkOut - record.checkIn) / 60000) : 0;
    await record.save();
    res.json(record);
  } catch (err) {
    res.status(400).json({ message: 'Could not save record' });
  }
});

module.exports = router;
