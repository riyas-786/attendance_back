const express = require('express');
const mongoose = require('mongoose');
const ExcelJS = require('exceljs');
const User = require('../models/User');
const Attendance = require('../models/Attendance');
const Adjustment = require('../models/Adjustment');
const { protect, adminOnly } = require('../middleware/auth');
const { computePayroll } = require('../utils/payroll');
const { getSettings } = require('../utils/settings');
const { resolvePeriod, datesBetween } = require('../utils/period');
const { workingDaysIn, payrollCfg } = require('../utils/payroll');

const router = express.Router();
router.use(protect, adminOnly);

const pad = (n) => String(n).padStart(2, '0');
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
/**
 * Payroll for a period. Optional filters (they combine):
 *   userId, department, shift (id), payType (monthly | daily | hourly)
 */
async function build(query) {
  const cfg = await getSettings();
  const period = resolvePeriod(query, cfg.payrollStartDay, todayKey());
  if (period.error) return { error: period.error };

  const isId = (v) => mongoose.isValidObjectId(String(v));
  if (query.userId && !isId(query.userId)) return { error: 'Invalid staff member' };
  if (query.shift && !isId(query.shift)) return { error: 'Invalid shift' };
  if (query.payType && !['monthly', 'daily', 'hourly'].includes(query.payType)) return { error: 'Pay type must be monthly, daily or hourly' };

  // employees only (admins are not on this payroll), active ones
  const who = { role: 'staff', active: true };
  if (query.userId) who._id = query.userId;
  if (query.department) who.department = String(query.department);
  if (query.shift) who.shift = query.shift;
  if (query.payType === 'monthly') who.payType = { $in: ['monthly', null] }; // staff set up before pay types existed are monthly
  else if (query.payType) who.payType = query.payType;
  const users = await User.find(who).sort({ name: 1 });

  const records = await Attendance.find({
    date: { $gte: period.from, $lte: period.to },
    user: { $in: users.map((u) => u._id) },
  });
  const adjustments = await Adjustment.find({
    user: { $in: users.map((u) => u._id) },
    // entries dated inside the period, plus older undated ones saved against this period key
    $or: [{ date: { $gte: period.from, $lte: period.to } }, { month: period.key, date: { $in: [null, ''] } }],
  }).sort({ date: 1, createdAt: 1 });
  return { data: computePayroll(period, users, records, todayKey(), cfg, adjustments), records, cfg, period };
}

// ---- the salary sheet: one header row, one row per employee, a total row (shared by Excel and CSV)
const TYPE_NAME = { monthly: 'Monthly', daily: 'Daily', hourly: 'Hourly' };
const headRow = (data) => [
  'Employee ID', 'Name', 'Department', 'Pay type', `Rate (${data.currency})`, 'Days / hours paid',
  `Basic pay (${data.currency})`, 'Working days', 'Days worked',
  'Paid leave', 'Unpaid leave', 'Absent', 'Late arrivals', 'Late deduction (days)',
  `Daily rate (${data.currency})`, `Attendance deduction (${data.currency})`,
  `Extra earnings (${data.currency})`, `Other deductions (${data.currency})`, `Net salary (${data.currency})`, 'Details',
];
const dataRow = (r) => [
  r.employeeId, r.name, r.department, TYPE_NAME[r.payType], r.rate,
  r.payType === 'hourly' ? `${r.hours} h` : r.payType === 'daily' ? `${r.paidDays} days` : '',
  r.baseSalary, r.workingDays, r.worked,
  r.paidLeave, r.unpaidLeave, r.absent, r.late, r.lateDeductionDays, r.dailyRate, r.deduction,
  r.additions, r.otherDeductions, r.netSalary,
  r.adjustments.map((a) => `${a.type === 'earning' ? '+' : '-'}${a.amount} ${a.label}${a.date ? ' ' + a.date : ''}${a.note ? ' (' + a.note + ')' : ''}`).join('; ') +
    (r.shortfall ? ` (not recovered: ${r.shortfall})` : ''),
];
const totalRow = (data) => ['', 'TOTAL', '', '', '', '', data.totals.baseSalary, '', '', '', '', '', '', '', '', data.totals.deduction, data.totals.additions, data.totals.otherDeductions, data.totals.netSalary, ''];
const fileBase = (data) => `payroll_${data.custom ? data.from + '_to_' + data.to : data.month}`;

const csvCell = (v) => {
  let s = v === undefined || v === null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection from typed text
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

router.get('/', async (req, res) => {
  try {
    const { data, error } = await build(req.query);
    if (error) return res.status(400).json({ message: error });
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: 'Could not calculate payroll' });
  }
});

router.get('/export.xlsx', async (req, res) => {
  try {
    const { data, error } = await build(req.query);
    if (error) return res.status(400).json({ message: error });

    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet(`Payroll ${data.custom ? data.from + ' to ' + data.to : data.month}`.slice(0, 31));
    sheet.addRow([...headRow(data), 'Signature']);
    data.rows.forEach((r) => sheet.addRow([...dataRow(r), '']));
    sheet.addRow([...totalRow(data), '']).font = { bold: true };

    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9EEFF' } };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    [12, 22, 16, 11, 14, 16, 18, 13, 12, 11, 12, 9, 13, 20, 17, 20, 18, 18, 17, 50, 22].forEach((w, i) => (sheet.getColumn(i + 1).width = w));
    // prints on one page width, landscape, with the header on every page; the Signature column is for the signed copy
    sheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
    sheet.headerFooter = { oddFooter: `&L${data.from} to ${data.to}&RPage &P of &N` };
    sheet.pageSetup.printTitlesRow = '1:1';
    sheet.eachRow((row, n) => { if (n > 1) row.height = 22; });
    [5, 7, 15, 16, 17, 18, 19].forEach((c) => (sheet.getColumn(c).numFmt = '#,##0.00'));

    // one line per extra earning / deduction, with its day and narration
    const extra = wb.addWorksheet('Extra items');
    extra.addRow(['Date', 'Employee ID', 'Name', 'Type', 'Item', 'Narration', `Amount (${data.currency})`]);
    data.rows.forEach((r) =>
      r.adjustments.forEach((a) =>
        extra.addRow([a.date, r.employeeId, r.name, a.type === 'earning' ? 'Extra earning' : 'Deduction', a.label, a.note, a.type === 'earning' ? a.amount : -a.amount])
      )
    );
    extra.getRow(1).font = { bold: true };
    extra.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9EEFF' } };
    [12, 12, 22, 14, 20, 50, 16].forEach((w, i) => (extra.getColumn(i + 1).width = w));
    extra.getColumn(7).numFmt = '#,##0.00;[Red]-#,##0.00';

    const note = wb.addWorksheet('How it is calculated');
    [
      [`Period: ${data.from} to ${data.to}${data.inProgress ? ' (period still in progress: absences counted up to yesterday)' : ''}`],
      [`Working days in the period: ${data.totalWorkingDays} (weekends and holidays excluded)`],
      ['Monthly staff: daily rate = monthly salary / working days in the period'],
      ['Monthly staff set to "by days present": basic pay = (monthly salary / working days in the period) x (days with a check-in + paid leave days); absences earn nothing'],
      ['Daily staff: basic pay = rate per day x (days with a check-in + paid leave days). Weekends and holidays worked are paid too. Absences earn nothing.'],
      [`Hourly staff: basic pay = rate per hour x hours worked (completed check-in/out sessions) + paid leave days x ${data.hoursPerDay || 8} hours`],
      [
        data.lateThreshold
          ? `Late rule: every ${data.lateThreshold} late arrivals = ${data.lateDays} day of pay deducted`
          : 'Late rule: switched off',
      ],
      [`Deduction = (absent days x ${data.deductionFactor} + unpaid leave days + late deduction days) x daily rate`],
      ['Annual, sick and other approved leave is paid and not deducted'],
      ['Extra earnings (overtime, incentive, bonus ...) are added; other deductions (advance, loan, fine ...) are subtracted'],
      ['Net salary = basic pay - attendance deduction + extra earnings - other deductions (never below 0)'],
    ].forEach((r) => note.addRow(r));
    note.getColumn(1).width = 100;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileBase(data)}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ message: 'Could not build payroll file' });
  }
});

// ---- salary slips: one sheet per employee, one printable A4 page each (see utils/slip.js)
const { drawSlip, MONTHS_LONG } = require('../utils/slip');
const periodTitle = (data) => {
  if (data.custom) return '';
  const [y, m] = data.month.split('-'); // a pay month is named by its end month
  return `${MONTHS_LONG[Number(m) - 1]} ${y}`;
};

router.get('/slips.xlsx', async (req, res) => {
  try {
    const { data, records, cfg, error } = await build(req.query);
    if (error) return res.status(400).json({ message: error });
    if (!data.rows.length) return res.status(404).json({ message: 'No employees match these filters' });

    const company = process.env.COMPANY_NAME || 'Teepee Group';
    const wcfg = payrollCfg(cfg);
    const allDays = datesBetween(data.from, data.to);
    const offDays = new Set(allDays.filter((d) => !workingDaysIn(d, d, wcfg).length));
    const today = todayKey();
    const byUser = new Map();
    for (const r of records) {
      const id = String(r.user?._id || r.user);
      if (!byUser.has(id)) byUser.set(id, new Map());
      byUser.get(id).set(r.date, r);
    }
    const users = new Map((await User.find({ _id: { $in: data.rows.map((r) => r.userId) } })).map((u) => [String(u._id), u]));

    const wb = new ExcelJS.Workbook();
    const used = new Set();
    for (const row of data.rows) {
      const u = users.get(String(row.userId));
      const recs = byUser.get(String(row.userId)) || new Map();
      // 1 = worked, L = paid leave, UL = unpaid leave, A = absent, Off = weekend / holiday, blank = not decided yet
      const dayCells = allDays.map((d) => {
        const r = recs.get(d);
        let mark = '';
        if (u?.joinDate && d < u.joinDate) mark = '';
        else if (r?.checkIn) mark = 1;
        else if (r?.status === 'leave') mark = r.leaveType === 'unpaid' ? 'UL' : 'L';
        else if (offDays.has(d)) mark = 'Off';
        else if (d < today) mark = 'A';
        return { date: d, mark };
      });

      let name = String(row.name || 'Employee').replace(/[\\/?*\[\]:]/g, ' ').slice(0, 28).trim() || 'Employee';
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${name.slice(0, 26)} ${n}`;
      used.add(name.toLowerCase());
      drawSlip(wb.addWorksheet(name), {
        company, title: periodTitle(data), from: data.from, to: data.to, currency: data.currency,
        row, joinDate: u?.joinDate || '', dayCells, generated: today,
      });
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="salary_slips_${data.custom ? data.from + '_to_' + data.to : data.month}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ message: 'Could not build salary slips' });
  }
});

router.get('/export.csv', async (req, res) => {
  try {
    const { data, error } = await build(req.query);
    if (error) return res.status(400).json({ message: error });
    const lines = [headRow(data), ...data.rows.map(dataRow), totalRow(data)].map((row) => row.map(csvCell).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileBase(data)}.csv"`);
    res.send('\ufeff' + lines.join('\r\n')); // BOM so Excel shows UTF-8 names correctly
  } catch (err) {
    res.status(500).json({ message: 'Could not build payroll file' });
  }
});

module.exports = router;
