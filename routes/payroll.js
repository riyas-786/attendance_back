const express = require('express');
const ExcelJS = require('exceljs');
const User = require('../models/User');
const Attendance = require('../models/Attendance');
const Adjustment = require('../models/Adjustment');
const { protect, adminOnly } = require('../middleware/auth');
const { computePayroll } = require('../utils/payroll');
const { getSettings } = require('../utils/settings');
const { resolvePeriod } = require('../utils/period');

const router = express.Router();
router.use(protect, adminOnly);

const pad = (n) => String(n).padStart(2, '0');
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
async function build(query) {
  const cfg = await getSettings();
  const period = resolvePeriod(query, cfg.payrollStartDay, todayKey());
  if (period.error) return { error: period.error };

  // employees only (admins are not on this payroll), active ones
  const users = await User.find({ role: 'staff', active: true }).sort({ name: 1 });
  const records = await Attendance.find({
    date: { $gte: period.from, $lte: period.to },
    user: { $in: users.map((u) => u._id) },
  });
  const adjustments = await Adjustment.find({
    user: { $in: users.map((u) => u._id) },
    // entries dated inside the period, plus older undated ones saved against this period key
    $or: [{ date: { $gte: period.from, $lte: period.to } }, { month: period.key, date: { $in: [null, ''] } }],
  }).sort({ date: 1, createdAt: 1 });
  return { data: computePayroll(period, users, records, todayKey(), cfg, adjustments) };
}

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
    const typeName = { monthly: 'Monthly', daily: 'Daily', hourly: 'Hourly' };
    sheet.addRow([
      'Employee ID', 'Name', 'Department', 'Pay type', `Rate (${data.currency})`, 'Days / hours paid',
      `Basic pay (${data.currency})`, 'Working days', 'Days worked',
      'Paid leave', 'Unpaid leave', 'Absent', 'Late arrivals', 'Late deduction (days)',
      `Daily rate (${data.currency})`, `Attendance deduction (${data.currency})`,
      `Extra earnings (${data.currency})`, `Other deductions (${data.currency})`, `Net salary (${data.currency})`, 'Details',
    ]);
    data.rows.forEach((r) =>
      sheet.addRow([
        r.employeeId, r.name, r.department, typeName[r.payType], r.rate,
        r.payType === 'hourly' ? `${r.hours} h` : r.payType === 'daily' ? `${r.paidDays} days` : '',
        r.baseSalary, r.workingDays, r.worked,
        r.paidLeave, r.unpaidLeave, r.absent, r.late, r.lateDeductionDays, r.dailyRate, r.deduction,
        r.additions, r.otherDeductions, r.netSalary,
        r.adjustments.map((a) => `${a.type === 'earning' ? '+' : '-'}${a.amount} ${a.label}${a.date ? ' ' + a.date : ''}${a.note ? ' (' + a.note + ')' : ''}`).join('; ') +
          (r.shortfall ? ` (not recovered: ${r.shortfall})` : ''),
      ])
    );
    const t = sheet.addRow(['', 'TOTAL', '', '', '', '', data.totals.baseSalary, '', '', '', '', '', '', '', '', data.totals.deduction, data.totals.additions, data.totals.otherDeductions, data.totals.netSalary, '']);
    t.font = { bold: true };

    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9EEFF' } };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    [12, 22, 16, 11, 14, 16, 18, 13, 12, 11, 12, 9, 13, 20, 17, 20, 18, 18, 17, 50].forEach((w, i) => (sheet.getColumn(i + 1).width = w));
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
    res.setHeader('Content-Disposition', `attachment; filename="payroll_${data.custom ? data.from + '_to_' + data.to : data.month}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ message: 'Could not build payroll file' });
  }
});

module.exports = router;
