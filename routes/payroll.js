const express = require('express');
const mongoose = require('mongoose');
const ExcelJS = require('exceljs');
const User = require('../models/User');
const Attendance = require('../models/Attendance');
const Adjustment = require('../models/Adjustment');
const { protect, adminOnly } = require('../middleware/auth');
const { computePayroll } = require('../utils/payroll');
const { getSettings } = require('../utils/settings');
const { resolvePeriod, datesBetween, isPeriodKey } = require('../utils/period');
const SalaryFunds = require('../models/SalaryFunds');
const { summarise } = require('../utils/salarySummary');
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


// ---- Salary summary: earned, advances, balance, cash vs bank, and how much more money is needed ----
async function buildSummary(query) {
  const { data, error, period } = await build(query);
  if (error) return { error };
  const users = await User.find({ _id: { $in: data.rows.map((r) => r.userId) } }).select('company salaryMode');
  const funds = (await SalaryFunds.findOne({ key: period.key })) || { cash: 0, bank: 0 };
  return {
    summary: {
      company: process.env.COMPANY_NAME || 'TEE PEE Group',
      currency: data.currency,
      period: { key: period.key, month: data.month, from: data.from, to: data.to, custom: !!data.custom, inProgress: data.inProgress },
      ...summarise(data, users, funds),
    },
  };
}

router.get('/summary', async (req, res) => {
  try {
    const { summary, error } = await buildSummary(req.query);
    if (error) return res.status(400).json({ message: error });
    res.json(summary);
  } catch (err) {
    res.status(500).json({ message: 'Could not build the salary summary' });
  }
});

// Money available for this period's salaries (typed in by the admin)
router.put('/funds', async (req, res) => {
  try {
    const { key } = req.body;
    if (typeof key !== 'string' || !isPeriodKey(key)) return res.status(400).json({ message: 'Invalid pay period' });
    const num = (v) => (v === '' || v === null || v === undefined ? 0 : Number(v));
    const cash = num(req.body.cash);
    const bank = num(req.body.bank);
    for (const n of [cash, bank]) {
      if (!Number.isFinite(n) || n < 0 || n > 1e10) return res.status(400).json({ message: 'Amounts must be 0 or more' });
    }
    const doc = await SalaryFunds.findOneAndUpdate({ key }, { key, cash, bank, updatedBy: req.user._id }, { upsert: true, new: true, setDefaultsOnInsert: true });
    res.json({ key: doc.key, cash: doc.cash, bank: doc.bank });
  } catch (err) {
    res.status(500).json({ message: 'Could not save the amounts' });
  }
});

router.get('/summary.xlsx', async (req, res) => {
  try {
    const { summary: s, error } = await buildSummary(req.query);
    if (error) return res.status(400).json({ message: error });
    const cur = s.currency;
    const money = `#,##0.00`;
    const FONT = 'Calibri';
    const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
    const thin = { style: 'thin', color: { argb: 'FFD9DDE3' } };
    const box = { top: thin, left: thin, bottom: thin, right: thin };

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Summary', { views: [{ showGridLines: false }] });
    [3, 34, 16, 18, 18, 18, 3].forEach((w, i) => (ws.getColumn(i + 1).width = w));
    let r = 1;
    const style = (row, o) => { for (let c = 2; c <= 6; c++) Object.assign(row.getCell(c), o); };

    // title
    ws.mergeCells(`B${r}:F${r}`);
    ws.getCell(`B${r}`).value = 'SALARY SUMMARY';
    ws.getCell(`B${r}`).font = { name: FONT, size: 20, bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getCell(`B${r}`).alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    style(ws.getRow(r), { fill: fill('FF1F2937') });
    ws.getRow(r).height = 36;
    r++;
    ws.mergeCells(`B${r}:F${r}`);
    ws.getCell(`B${r}`).value = `${s.company}  ·  ${s.period.custom ? s.period.from + ' to ' + s.period.to : s.period.month}  (${s.period.from} to ${s.period.to})  ·  Amounts in ${cur}${s.period.inProgress ? '  ·  period still running: figures are so far' : ''}`;
    ws.getCell(`B${r}`).font = { name: FONT, size: 11, color: { argb: 'FF374151' } };
    ws.getCell(`B${r}`).alignment = { indent: 1, vertical: 'middle' };
    style(ws.getRow(r), { fill: fill('FFF3F4F6') });
    ws.getRow(r).height = 22;
    r += 2;

    const section = (text, color) => {
      ws.mergeCells(`B${r}:F${r}`);
      const c = ws.getCell(`B${r}`);
      c.value = text;
      c.font = { name: FONT, size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
      c.alignment = { indent: 1, vertical: 'middle' };
      style(ws.getRow(r), { fill: fill(color) });
      ws.getRow(r).height = 24;
      r++;
    };
    const head = (labels) => {
      labels.forEach((t, i) => {
        const c = ws.getCell(r, 2 + i);
        c.value = t;
        c.font = { name: FONT, bold: true, color: { argb: 'FF374151' } };
        c.fill = fill('FFE5E7EB');
        c.border = box;
        c.alignment = { horizontal: i === 0 ? 'left' : 'right', vertical: 'middle', indent: i === 0 ? 1 : 0 };
      });
      ws.getRow(r).height = 22;
      r++;
    };
    const line = (label, vals, opt = {}) => {
      const row = ws.getRow(r);
      row.getCell(2).value = label;
      vals.forEach((v, i) => { row.getCell(3 + i).value = v; });
      for (let c = 2; c <= 2 + vals.length; c++) {
        const cell = row.getCell(c);
        cell.font = { name: FONT, size: 11, bold: !!opt.bold, color: { argb: opt.color || 'FF111827' } };
        cell.border = box;
        if (opt.fill) cell.fill = fill(opt.fill);
        if (c > 2) { cell.alignment = { horizontal: 'right', vertical: 'middle' }; cell.numFmt = opt.fmts ? opt.fmts[c - 3] : money; }
        else cell.alignment = { indent: 1, vertical: 'middle' };
      }
      row.height = 22;
      r++;
      return r - 1;
    };

    // 1. salary, advance, balance
    section('1.  SALARY, ADVANCE AND BALANCE', 'FF2563EB');
    head(['', `Amount (${cur})`]);
    const rEarned = line('Total salary for the period', [s.totals.earned], { bold: true });
    const rAdv = line('Advance already paid', [s.totals.advance], { color: 'FFB91C1C' });
    let rOther = null;
    if (s.totals.otherDeductions > 0) rOther = line('Other deductions (fines, loans)', [s.totals.otherDeductions], { color: 'FFB91C1C' });
    const rBal = line('Balance salary to pay', [{ formula: `C${rEarned}-C${rAdv}${rOther ? `-C${rOther}` : ''}`, result: s.totals.earned - s.totals.advance - s.totals.otherDeductions }], { bold: true, fill: 'FFDCFCE7', color: 'FF166534' });
    r++;

    // 2. cash vs bank
    section('2.  HOW THE BALANCE IS PAID', 'FF0F766E');
    head(['', 'Staff', `Amount (${cur})`]);
    const rCash = line('Balance paid by CASH', [s.payBy.cash.staff, s.payBy.cash.amount], { fmts: ['0', money] });
    const rBank = line('Balance paid by BANK', [s.payBy.bank.staff, s.payBy.bank.amount], { fmts: ['0', money] });
    line('Total balance', [{ formula: `C${rCash}+C${rBank}`, result: s.payBy.cash.staff + s.payBy.bank.staff }, { formula: `D${rCash}+D${rBank}`, result: s.payBy.cash.amount + s.payBy.bank.amount }], { bold: true, fill: 'FFE5E7EB', fmts: ['0', money] });
    r++;

    // 3. funds needed
    section('3.  MONEY READY vs MONEY NEEDED', 'FFB91C1C');
    head(['', 'To pay', 'Available', 'Additional needed', 'Spare']);
    const rFc = r;
    line('CASH (in hand)', [s.payBy.cash.amount, s.funds.cash, { formula: `MAX(0,C${rFc}-D${rFc})`, result: s.need.cash }, { formula: `MAX(0,D${rFc}-C${rFc})`, result: s.spare.cash }]);
    const rFb = r;
    line('BANK (balance)', [s.payBy.bank.amount, s.funds.bank, { formula: `MAX(0,C${rFb}-D${rFb})`, result: s.need.bank }, { formula: `MAX(0,D${rFb}-C${rFb})`, result: s.spare.bank }]);
    line('TOTAL', [0, 1, 2, 3].map((i) => { const col = 'CDEF'[i]; return { formula: `${col}${rFc}+${col}${rFb}`, result: [s.payBy.cash.amount + s.payBy.bank.amount, s.funds.cash + s.funds.bank, s.needTotal, s.spare.cash + s.spare.bank][i] }; }), { bold: true, fill: 'FFFEE2E2', color: 'FF991B1B' });
    // "Available" is typed in by the admin: blue text, light yellow fill (change it here and the rest recalculates)
    [rFc, rFb].forEach((x) => { const c = ws.getCell(x, 4); c.font = { name: FONT, size: 11, color: { argb: 'FF0000FF' } }; c.fill = fill('FFFFF9DB'); });
    ws.mergeCells(`B${r}:F${r}`);
    ws.getCell(`B${r}`).value = 'Blue cells are the money available (entered in the app). Change them here and "Additional needed" recalculates.';
    ws.getCell(`B${r}`).font = { name: FONT, size: 9, italic: true, color: { argb: 'FF6B7280' } };
    r += 2;

    // 4. by company (only when companies are set)
    if (s.byCompany.some((g) => g.company)) {
      section('4.  BY COMPANY', 'FF7C3AED');
      head(['Company', 'Staff', 'Total salary', 'Advance paid', 'Balance to pay']);
      const first = r;
      s.byCompany.forEach((g) => line(g.company || 'No company set', [g.staff, g.earned, g.advance, g.balance], { fmts: ['0', money, money, money] }));
      const last = r - 1;
      line('Total', ['C', 'D', 'E', 'F'].map((col, i) => ({ formula: `SUM(${col}${first}:${col}${last})`, result: [s.totals.staff, s.totals.earned, s.totals.advance, s.totals.balance][i] })), { bold: true, fill: 'FFE5E7EB', fmts: ['0', money, money, money] });
    }
    ws.pageSetup = { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 1, paperSize: 9, horizontalCentered: true };

    // staff detail
    const d = wb.addWorksheet('Staff detail', { views: [{ state: 'frozen', ySplit: 1 }] });
    const cols = [['Employee ID', 13], ['Name', 24], ['Company', 18], ['Department', 16], [`Salary (${cur})`, 15], [`Advance paid (${cur})`, 18], [`Other deductions (${cur})`, 20], [`Balance to pay (${cur})`, 19], ['Paid by', 10]];
    d.addRow(cols.map((c) => c[0]));
    cols.forEach((c, i) => (d.getColumn(i + 1).width = c[1]));
    s.rows.forEach((x) => d.addRow([x.employeeId, x.name, x.company, x.department, x.earned, x.advance, x.otherDeductions, x.balance, x.mode === 'cash' ? 'Cash' : 'Bank']));
    const n = s.rows.length;
    const tot = d.addRow(['', 'TOTAL', '', '', ...['E', 'F', 'G', 'H'].map((col, i) => ({ formula: `SUM(${col}2:${col}${n + 1})`, result: [s.totals.earned, s.totals.advance, s.totals.otherDeductions, s.totals.balance][i] })), '']);
    d.getRow(1).eachCell((c) => { c.font = { name: FONT, bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = fill('FF1F2937'); c.alignment = { vertical: 'middle', wrapText: true }; });
    d.getRow(1).height = 28;
    tot.font = { name: FONT, bold: true };
    tot.eachCell((c) => { c.fill = fill('FFE5E7EB'); });
    for (let i = 2; i <= n + 2; i++) { [5, 6, 7, 8].forEach((c) => (d.getRow(i).getCell(c).numFmt = money)); if (i <= n + 1) d.getRow(i).getCell(9).alignment = { horizontal: 'center' }; }
    d.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
    d.pageSetup.printTitlesRow = '1:1';

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="salary_summary_${s.period.custom ? s.period.from + '_to_' + s.period.to : s.period.month}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    res.status(500).json({ message: 'Could not build the salary summary file' });
  }
});

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

    const company = process.env.COMPANY_NAME || 'TEE PEE Group';
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
