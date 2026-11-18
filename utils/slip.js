// Draws one salary slip (one worksheet): header band, employee details, attendance numbers,
// a calendar of the pay period, earnings and deductions side by side, net salary in figures and words, signatures.

const BRAND = 'FFED193A';
const INK = 'FF1D1B22';
const MUTED = 'FF6F6B78';
const LINE = 'FFD9D5DF';
const SOFT = 'FFF5F4F7';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const below1000 = (n) => {
  const out = [];
  if (n >= 100) { out.push(ONES[Math.floor(n / 100)], 'Hundred'); n %= 100; }
  if (n >= 20) { out.push(TENS[Math.floor(n / 10)]); n %= 10; }
  if (n) out.push(ONES[n]);
  return out.join(' ');
};
function numberWords(n, indian) {
  if (n === 0) return 'Zero';
  const units = indian ? [[10000000, 'Crore'], [100000, 'Lakh'], [1000, 'Thousand']] : [[1000000000, 'Billion'], [1000000, 'Million'], [1000, 'Thousand']];
  const parts = [];
  for (const [size, name] of units) {
    if (n >= size) { parts.push(`${numberWords(Math.floor(n / size), indian)} ${name}`); n %= size; }
  }
  if (n) parts.push(below1000(n));
  return parts.join(' ');
}
const NAMES = { INR: ['Rupees', 'Paise'], AED: ['Dirhams', 'Fils'] };
function amountInWords(amount, currency) {
  const total = Math.round(Math.max(0, Number(amount) || 0) * 100);
  const whole = Math.floor(total / 100);
  const minor = total % 100;
  const [big, small] = NAMES[currency] || [currency, ''];
  let text = `${big} ${numberWords(whole, currency === 'INR')}`;
  if (minor) text += small ? ` and ${numberWords(minor, false)} ${small}` : ` and ${String(minor).padStart(2, '0')}/100`;
  return `${text} Only`;
}

const dShort = (key) => { const [, m, d] = key.split('-'); return `${Number(d)} ${MONTHS[Number(m) - 1]}`; };
const dFull = (key) => { const [y, m, d] = key.split('-'); return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`; };
const fmt = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function describeBasic(row, currency) {
  if (row.payType === 'daily') return `${row.paidDays} days x ${fmt(row.rate)}`;
  if (row.payType === 'hourly') return `${row.hours} h x ${fmt(row.rate)}${row.paidLeave ? ` + ${row.paidLeave} leave day(s)` : ''}`;
  if (row.payMethod === 'days') return `${row.paidDays} of ${row.workingDays} days at ${fmt(row.dailyRate)}`;
  return 'Monthly salary';
}

/**
 * ws        worksheet
 * ctx       { company, title (e.g. "Oct 2026"), period {from,to}, currency, row, user, dayCells }
 *           dayCells: [{ date, mark }]  mark is 1 | 'L' | 'UL' | 'A' | 'Off' | ''
 */
function drawSlip(ws, ctx) {
  const { company, title, from, to, currency, row, dayCells, generated } = ctx;
  const COLS = 14;
  ws.columns = Array.from({ length: COLS }, () => ({ width: 6.6 }));
  ws.pageSetup = { orientation: 'portrait', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 1, horizontalCentered: true, margins: { left: 0.45, right: 0.45, top: 0.45, bottom: 0.45, header: 0.2, footer: 0.2 } };
  ws.views = [{ showGridLines: false }];

  const solid = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
  const thin = { style: 'thin', color: { argb: LINE } };
  const box = { top: thin, left: thin, bottom: thin, right: thin };
  let r = 1;
  const cell = (rr, c1, c2, value, o = {}) => {
    if (c2 > c1) ws.mergeCells(rr, c1, rr, c2);
    const c = ws.getCell(rr, c1);
    c.value = value;
    c.font = { name: 'Calibri', size: o.size || 11, bold: !!o.bold, italic: !!o.italic, color: { argb: o.color || INK } };
    c.alignment = { horizontal: o.align || 'left', vertical: o.v || 'middle', wrapText: !!o.wrap, indent: o.indent || 0 };
    for (let k = c1; k <= c2; k++) {
      const x = ws.getCell(rr, k);
      if (o.fill) x.fill = solid(o.fill);
      if (o.border) x.border = o.border;
    }
    return c;
  };
  const gap = (h = 8) => { ws.getRow(r).height = h; r += 1; };

  // ---- header band
  ws.getRow(r).height = 38;
  cell(r, 1, 8, company, { size: 20, bold: true, color: 'FFFFFFFF', fill: BRAND, indent: 1 });
  cell(r, 9, 14, 'SALARY SLIP', { size: 14, bold: true, color: 'FFFFFFFF', fill: BRAND, align: 'right', indent: 1 });
  r += 1;
  ws.getRow(r).height = 22;
  cell(r, 1, 14, `Pay period  ${dFull(from)}  to  ${dFull(to)}${title ? `   (${title})` : ''}`, { size: 10.5, color: MUTED, fill: SOFT, indent: 1 });
  r += 1;
  gap(10);

  // ---- employee
  const rate = row.payType === 'monthly' ? `${fmt(row.rate)} per month${row.payMethod === 'days' ? ' (by days present)' : ' (fixed)'}` : row.payType === 'daily' ? `${fmt(row.rate)} per day` : `${fmt(row.rate)} per hour`;
  const info = [
    [['Employee', row.name], ['Pay type', { monthly: 'Monthly', daily: 'Daily', hourly: 'Hourly' }[row.payType]]],
    [['Employee ID', row.employeeId || '-'], ['Rate', `${currency} ${rate}`]],
    [['Department', row.department || '-'], ['Joined', ctx.joinDate ? dFull(ctx.joinDate) : '-']],
  ];
  info.forEach(([a, b], i) => {
    ws.getRow(r).height = i === 0 ? 24 : 19;
    cell(r, 1, 2, a[0], { color: MUTED, size: 10, indent: 1 });
    cell(r, 3, 7, a[1], { bold: true, size: i === 0 ? 14 : 11 });
    cell(r, 8, 9, b[0], { color: MUTED, size: 10 });
    cell(r, 10, 14, b[1], { bold: true });
    r += 1;
  });
  gap(10);

  // ---- attendance numbers
  const boxes = [
    ['Present', row.worked, 'FF0E8A55'],
    ['Paid leave', row.paidLeave, 'FF3A49C9'],
    ['Unpaid leave', row.unpaidLeave, 'FFB86A00'],
    ['Absent', row.absent, 'FFC62B2B'],
    ['Late', row.late, INK],
    row.payType === 'hourly' ? ['Hours worked', row.hours, INK] : ['Working days', row.workingDays, INK],
    ['Days paid', row.payType === 'monthly' && row.payMethod !== 'days' ? row.workingDays - row.absent - row.unpaidLeave : row.paidDays, INK],
  ];
  ws.getRow(r).height = 17;
  boxes.forEach(([label], i) => cell(r, i * 2 + 1, i * 2 + 2, label, { size: 9.5, color: MUTED, align: 'center', fill: SOFT, border: { top: thin, left: thin, right: thin } }));
  r += 1;
  ws.getRow(r).height = 30;
  boxes.forEach(([, v, color], i) => cell(r, i * 2 + 1, i * 2 + 2, v, { size: 18, bold: true, color, align: 'center', fill: SOFT, border: { bottom: thin, left: thin, right: thin } }));
  r += 1;
  gap(10);

  // ---- calendar of the pay period (weeks start on Monday)
  const toDow = (key) => (new Date(`${key}T00:00:00Z`).getUTCDay() + 6) % 7;
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  ws.getRow(r).height = 18;
  names.forEach((n, i) => cell(r, i * 2 + 1, i * 2 + 2, n, { size: 9.5, bold: true, color: MUTED, align: 'center' }));
  r += 1;
  const markStyle = {
    1: { fill: 'FFE3F5EC', color: 'FF0E8A55' },
    L: { fill: 'FFEAECFD', color: 'FF3A49C9' },
    UL: { fill: 'FFFFF0D6', color: 'FFB86A00' },
    A: { fill: 'FFFDEAEA', color: 'FFC62B2B' },
    Off: { fill: SOFT, color: MUTED },
    '': { fill: 'FFFFFFFF', color: MUTED },
  };
  let weekStart = r;
  let started = false;
  dayCells.forEach((d, i) => {
    const dow = toDow(d.date);
    if (i === 0 || dow === 0) {
      if (i !== 0) weekStart += 2;
      ws.getRow(weekStart).height = 15;
      ws.getRow(weekStart + 1).height = 19;
      started = true;
    }
    const c = dow * 2 + 1;
    const st = markStyle[d.mark] || markStyle[''];
    const [, m, dd] = d.date.split('-');
    const label = Number(dd) === 1 || i === 0 ? `${Number(dd)} ${MONTHS[Number(m) - 1]}` : String(Number(dd));
    cell(weekStart, c, c + 1, label, { size: 9, color: MUTED, align: 'center', fill: st.fill, border: { top: thin, left: thin, right: thin } });
    cell(weekStart + 1, c, c + 1, d.mark, { size: 12, bold: true, color: st.color, align: 'center', fill: st.fill, border: { bottom: thin, left: thin, right: thin } });
  });
  r = (started ? weekStart + 2 : r);
  ws.getRow(r).height = 16;
  cell(r, 1, 14, '1 = present     L = paid leave     UL = unpaid leave     A = absent     Off = weekend / holiday', { size: 9, color: MUTED, align: 'center' });
  r += 1;
  gap(10);

  // ---- earnings | deductions
  ws.getRow(r).height = 22;
  cell(r, 1, 7, 'Earnings', { bold: true, color: 'FFFFFFFF', fill: INK, indent: 1 });
  cell(r, 8, 14, 'Deductions', { bold: true, color: 'FFFFFFFF', fill: INK, indent: 1 });
  r += 1;

  const earn = [{ label: 'Basic pay', note: describeBasic(row, currency), amount: row.baseSalary }];
  row.adjustments.filter((a) => a.type === 'earning').forEach((a) => earn.push({ label: a.label, note: [a.date ? dShort(a.date) : '', a.note].filter(Boolean).join(' - '), amount: a.amount }));
  const ded = [];
  const bits = [];
  if (row.payMethod === 'days' || row.payType !== 'monthly') {
    if (row.lateDeductionDays) bits.push(`late ${row.lateDeductionDays} day(s)`);
  } else {
    if (row.absent) bits.push(`${row.absent} absent`);
    if (row.unpaidLeave) bits.push(`${row.unpaidLeave} unpaid leave`);
    if (row.lateDeductionDays) bits.push(`late ${row.lateDeductionDays} day(s)`);
  }
  ded.push({ label: 'Attendance deduction', note: bits.join(', ') || 'None', amount: row.deduction });
  row.adjustments.filter((a) => a.type === 'deduction').forEach((a) => ded.push({ label: a.label, note: [a.date ? dShort(a.date) : '', a.note].filter(Boolean).join(' - '), amount: a.amount }));

  const lines = Math.max(earn.length, ded.length, 3);
  for (let i = 0; i < lines; i++) {
    ws.getRow(r).height = 31;
    const put = (side, item) => {
      const c0 = side === 0 ? 1 : 8;
      const rich = item
        ? { richText: [{ text: item.label, font: { bold: true, size: 11, color: { argb: INK } } }, { text: item.note ? `\n${item.note}` : '', font: { size: 9, color: { argb: MUTED } } }] }
        : '';
      cell(r, c0, c0 + 4, rich, { wrap: true, indent: 1, border: { bottom: thin } });
      cell(r, c0 + 5, c0 + 6, item ? item.amount : '', { align: 'right', bold: true, border: { bottom: thin } });
      if (item) ws.getCell(r, c0 + 5).numFmt = '#,##0.00';
    };
    put(0, earn[i]);
    put(1, ded[i]);
    r += 1;
  }
  const totalEarn = earn.reduce((t, x) => t + x.amount, 0);
  const totalDed = ded.reduce((t, x) => t + x.amount, 0);
  ws.getRow(r).height = 24;
  cell(r, 1, 5, 'Total earnings', { bold: true, fill: SOFT, indent: 1 });
  cell(r, 6, 7, totalEarn, { bold: true, align: 'right', fill: SOFT });
  cell(r, 8, 12, 'Total deductions', { bold: true, fill: SOFT, indent: 1 });
  cell(r, 13, 14, totalDed, { bold: true, align: 'right', fill: SOFT });
  ws.getCell(r, 6).numFmt = '#,##0.00';
  ws.getCell(r, 13).numFmt = '#,##0.00';
  r += 1;
  gap(10);

  // ---- net salary
  ws.getRow(r).height = 40;
  cell(r, 1, 9, 'Net salary payable', { size: 15, bold: true, color: 'FFFFFFFF', fill: BRAND, indent: 1 });
  cell(r, 10, 14, `${currency} ${fmt(row.netSalary)}`, { size: 18, bold: true, color: 'FFFFFFFF', fill: BRAND, align: 'right', indent: 1 });
  r += 1;
  ws.getRow(r).height = row.shortfall ? 34 : 24;
  cell(r, 1, 14, amountInWords(row.netSalary, currency) + (row.shortfall ? `\nNot recovered this period: ${currency} ${fmt(row.shortfall)} (deductions were more than the pay)` : ''), { size: 10.5, italic: true, color: MUTED, wrap: true, indent: 1, fill: SOFT });
  r += 1;
  gap(34);

  // ---- signatures
  ws.getRow(r).height = 18;
  cell(r, 1, 6, 'Prepared / approved by', { size: 10, color: MUTED, border: { top: { style: 'thin', color: { argb: INK } } } });
  cell(r, 9, 14, 'Received by (employee) - name, sign, date', { size: 10, color: MUTED, border: { top: { style: 'thin', color: { argb: INK } } } });
  r += 1;
  gap(12);
  ws.getRow(r).height = 15;
  cell(r, 1, 14, `Generated ${dFull(generated)} - ${company}`, { size: 8.5, color: MUTED, align: 'center' });
  ws.pageSetup.printArea = `A1:N${r}`;
}

module.exports = { drawSlip, amountInWords, MONTHS_LONG };
