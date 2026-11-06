// Pure calculation, no database access, so it is easy to test.
// `s` is the settings object from utils/settings.js getSettings().

const pad = (n) => String(n).padStart(2, '0');
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function payrollCfg(s) {
  const threshold = Math.floor(Number(s.lateCountThreshold));
  return {
    weekend: s.weekendDays || [], // 0 = Sunday ... 6 = Saturday
    holidays: new Set(s.holidays || []),
    factor: Number.isFinite(Number(s.absentDeductionFactor)) ? Number(s.absentDeductionFactor) : 1,
    // every `lateThreshold` late arrivals deduct `lateDays` days of pay; 0 = off
    lateThreshold: Number.isFinite(threshold) && threshold > 0 ? threshold : 0,
    lateDays: Number.isFinite(Number(s.lateDeductionDays)) ? Number(s.lateDeductionDays) : 0.5,
    currency: s.salaryCurrency || 'AED',
  };
}

// All working days (YYYY-MM-DD) in a month, excluding weekends and holidays
function workingDaysOf(month, cfg) {
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const out = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${y}-${pad(m)}-${pad(d)}`;
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (cfg.weekend.includes(dow) || cfg.holidays.has(key)) continue;
    out.push(key);
  }
  return out;
}

/**
 * month   'YYYY-MM'
 * users   [{ _id, name, employeeId, department, baseSalary, joinDate }]
 * records Attendance docs (or plain objects) for the month: { user, date, checkIn, status, leaveType }
 * today   'YYYY-MM-DD' (server date). Days from today onwards are not judged yet.
 * s       settings (see above)
 */
function computePayroll(month, users, records, today, s) {
  const cfg = payrollCfg(s);
  const workingDays = workingDaysOf(month, cfg);
  const totalWorkingDays = workingDays.length;

  const byUser = new Map();
  for (const r of records) {
    const id = String(r.user?._id || r.user);
    if (!byUser.has(id)) byUser.set(id, new Map());
    byUser.get(id).set(r.date, r);
  }

  const rows = users.map((u) => {
    const recs = byUser.get(String(u._id)) || new Map();
    const base = Number(u.baseSalary) || 0;
    const dailyRate = totalWorkingDays ? base / totalWorkingDays : 0;

    let counted = 0; // working days that are in scope for this employee
    let worked = 0;
    let paidLeave = 0;
    let unpaidLeave = 0;
    let absent = 0;
    let late = 0;

    for (const date of workingDays) {
      if (u.joinDate && date < u.joinDate) continue; // not employed yet
      counted += 1;
      const r = recs.get(date);

      if (r?.checkIn) {
        worked += 1;
        if (r.status === 'late') late += 1;
        continue;
      }
      if (r?.status === 'leave') {
        if (r.leaveType === 'unpaid') unpaidLeave += 1;
        else paidLeave += 1;
        continue;
      }
      // Today and future days are not judged: the person may still check in
      if (date >= today && r?.status !== 'absent') continue;
      absent += 1;
    }

    const lateBlocks = cfg.lateThreshold ? Math.floor(late / cfg.lateThreshold) : 0;
    const lateDeductionDays = lateBlocks * cfg.lateDays;
    const deductionDays = absent * cfg.factor + unpaidLeave + lateDeductionDays;
    const deduction = round2(Math.min(deductionDays * dailyRate, base));
    return {
      userId: u._id,
      name: u.name,
      employeeId: u.employeeId || '',
      department: u.department || '',
      baseSalary: round2(base),
      workingDays: counted,
      worked,
      paidLeave,
      unpaidLeave,
      absent,
      late,
      lateDeductionDays,
      dailyRate: round2(dailyRate),
      deduction,
      netSalary: round2(base - deduction),
    };
  });

  const totals = rows.reduce(
    (t, r) => ({
      baseSalary: round2(t.baseSalary + r.baseSalary),
      deduction: round2(t.deduction + r.deduction),
      netSalary: round2(t.netSalary + r.netSalary),
    }),
    { baseSalary: 0, deduction: 0, netSalary: 0 }
  );

  return {
    month,
    currency: cfg.currency,
    totalWorkingDays,
    deductionFactor: cfg.factor,
    lateThreshold: cfg.lateThreshold,
    lateDays: cfg.lateDays,
    // true while the month is still running: figures are "so far", not final
    inProgress: today.slice(0, 7) <= month,
    rows,
    totals,
  };
}

module.exports = { computePayroll, workingDaysOf, payrollCfg };
