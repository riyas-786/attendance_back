// Salary summary: what is earned, what was already paid as advance, what is left to pay,
// how much of that goes out as cash or by bank, and how much more money is needed.

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const ADVANCE_RE = /advance/i; // deduction items named "Advance", "Salary advance" ...

/**
 * data  = computePayroll(...) result
 * users = the User documents of those rows (for company and how each person is paid)
 * funds = { cash, bank } available for the period
 */
function summarise(data, users, funds) {
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const rows = data.rows.map((r) => {
    const u = byId.get(String(r.userId));
    const advance = r2(r.adjustments.filter((a) => a.type === 'deduction' && ADVANCE_RE.test(a.label)).reduce((t, a) => t + a.amount, 0));
    return {
      userId: r.userId,
      name: r.name,
      employeeId: r.employeeId,
      department: r.department,
      company: (u && u.company) || '',
      mode: u && u.salaryMode === 'cash' ? 'cash' : 'bank',
      earned: r2(r.baseSalary - r.deduction + r.additions), // salary for the period, before any advance
      advance,
      otherDeductions: r2(r.otherDeductions - advance), // fines, loan repayments ...
      balance: r.netSalary, // left to pay
      shortfall: r.shortfall, // deductions that were bigger than the salary (not recovered)
    };
  });

  const sum = (list, f) => r2(list.reduce((t, x) => t + f(x), 0));
  const totals = {
    staff: rows.length,
    earned: sum(rows, (x) => x.earned),
    advance: sum(rows, (x) => x.advance),
    otherDeductions: sum(rows, (x) => x.otherDeductions),
    balance: sum(rows, (x) => x.balance),
  };

  const mode = (m) => {
    const list = rows.filter((x) => x.mode === m && x.balance > 0);
    return { staff: list.length, amount: sum(list, (x) => x.balance) };
  };
  const payBy = { cash: mode('cash'), bank: mode('bank') };

  const have = { cash: r2(funds && funds.cash), bank: r2(funds && funds.bank) };
  const need = {
    cash: r2(Math.max(0, payBy.cash.amount - have.cash)),
    bank: r2(Math.max(0, payBy.bank.amount - have.bank)),
  };
  const spare = {
    cash: r2(Math.max(0, have.cash - payBy.cash.amount)),
    bank: r2(Math.max(0, have.bank - payBy.bank.amount)),
  };

  const groups = new Map();
  rows.forEach((x) => {
    const k = x.company || '';
    const g = groups.get(k) || { company: k, staff: 0, earned: 0, advance: 0, balance: 0, cash: 0, bank: 0 };
    g.staff += 1;
    g.earned = r2(g.earned + x.earned);
    g.advance = r2(g.advance + x.advance);
    g.balance = r2(g.balance + x.balance);
    g[x.mode] = r2(g[x.mode] + x.balance);
    groups.set(k, g);
  });
  const byCompany = [...groups.values()].sort((a, b) => (a.company || '~').localeCompare(b.company || '~'));

  return { rows, totals, payBy, funds: have, need, spare, needTotal: r2(need.cash + need.bank), byCompany };
}

module.exports = { summarise, ADVANCE_RE };
