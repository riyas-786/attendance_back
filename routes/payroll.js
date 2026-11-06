const express = require('express');
const ExcelJS = require('exceljs');
const User = require('../models/User');
const Attendance = require('../models/Attendance');
const { protect, adminOnly } = require('../middleware/auth');
const { computePayroll } = require('../utils/payroll');
const { getSettings } = require('../utils/settings');

const router = express.Router();
router.use(protect, adminOnly);

const pad = (n) => String(n).padStart(2, '0');
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

async function build(monthParam) {
  const month = monthParam || todayKey().slice(0, 7);
  if (!MONTH_RE.test(month)) return { error: 'month must be YYYY-MM' };

  // employees only (admins are not on this payroll), active ones
  const users = await User.find({ role: 'staff', active: true }).sort({ name: 1 });
  const records = await Attendance.find({
    date: { $gte: `${month}-01`, $lte: `${month}-31` },
    user: { $in: users.map((u) => u._id) },
  });
  return { data: computePayroll(month, users, records, todayKey(), await getSettings()) };
}

router.get('/', async (req, res) => {
  try {
    const { data, error } = await build(req.query.month);
    if (error) return res.status(400).json({ message: error });
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: 'Could not calculate payroll' });
  }
});

router.get('/export.xlsx', async (req, res) => {
  try {
    const { data, error } = await build(req.query.month);
    if (error) return res.status(400).json({ message: error });

    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet(`Payroll ${data.month}`);
    sheet.addRow([
      'Employee ID', 'Name', 'Department', `Base salary (${data.currency})`, 'Working days', 'Days worked',
      'Paid leave', 'Unpaid leave', 'Absent', 'Late arrivals', 'Late deduction (days)',
      `Daily rate (${data.currency})`, `Deduction (${data.currency})`, `Net salary (${data.currency})`,
    ]);
    data.rows.forEach((r) =>
      sheet.addRow([
        r.employeeId, r.name, r.department, r.baseSalary, r.workingDays, r.worked,
        r.paidLeave, r.unpaidLeave, r.absent, r.late, r.lateDeductionDays, r.dailyRate, r.deduction, r.netSalary,
      ])
    );
    const t = sheet.addRow(['', 'TOTAL', '', data.totals.baseSalary, '', '', '', '', '', '', '', '', data.totals.deduction, data.totals.netSalary]);
    t.font = { bold: true };

    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9EEFF' } };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    [12, 22, 16, 18, 13, 12, 11, 12, 9, 13, 20, 17, 17, 17].forEach((w, i) => (sheet.getColumn(i + 1).width = w));
    [4, 12, 13, 14].forEach((c) => (sheet.getColumn(c).numFmt = '#,##0.00'));

    const note = wb.addWorksheet('How it is calculated');
    [
      [`Month: ${data.month}${data.inProgress ? ' (month still in progress: absences counted up to yesterday)' : ''}`],
      [`Working days in the month: ${data.totalWorkingDays} (weekends and holidays excluded)`],
      ['Daily rate = base salary / working days in the month'],
      [
        data.lateThreshold
          ? `Late rule: every ${data.lateThreshold} late arrivals = ${data.lateDays} day of pay deducted`
          : 'Late rule: switched off',
      ],
      [`Deduction = (absent days x ${data.deductionFactor} + unpaid leave days + late deduction days) x daily rate`],
      ['Annual, sick and other approved leave is paid and not deducted'],
      ['Net salary = base salary - deduction (never below 0)'],
    ].forEach((r) => note.addRow(r));
    note.getColumn(1).width = 100;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="payroll_${data.month}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ message: 'Could not build payroll file' });
  }
});

module.exports = router;
