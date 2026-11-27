// Pure calculation, no database access, so it is easy to test.
// `s` is the settings object from utils/settings.js getSettings().

const { monthPeriod, datesBetween } = require('./period');

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
    hoursPerDay: Number(s.payHoursPerDay) > 0 ? Number(s.payHoursPerDay) : 8,
    monthlyMethod: s.monthlyMethod === 'days' ? 'days' : 'fixed',
    otMultiplier: Number(s.holidayOtMultiplier) > 0 ? Number(s.holidayOtMultiplier) : 1,
  };
}

// Is this date a weekend or a holiday?
function isOffDay(date, cfg) {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return cfg.weekend.includes(dow) || cfg.holidays.has(date);
}

// Attendance on a weekend / holiday that the admin has to accept (as OT) or reject
function isOtCandidate(r, date, wdSet, u, period) {
  return !!(r && r.checkIn && !wdSet.has(date) && date >= period.from && date <= period.to
    && !(u.joinDate && date < u.joinDate) && r.status !== 'leave' && r.status !== 'absent');
}

// Pay for one accepted OT day: a day's pay x the OT rate x the % accepted; hourly staff: hours worked x hourly rate x OT rate x the % accepted
const otShare = (r) => { const p = Number(r.otPercent); return p >= 1 && p <= 100 ? p / 100 : 1; };
function otPay({ payType, rate, dailyRate }, r, mult) {
  if (payType === 'hourly') return round2(rate * ((Number(r.workedMinutes) || 0) / 60) * mult * otShare(r));
  return round2(dailyRate * mult * otShare(r));
}

// All working days (YYYY-MM-DD) from..to inclusive, excluding weekends and holidays
function workingDaysIn(from, to, cfg) {
  return datesBetween(from, to).filter((key) => {
    const dow = new Date(`${key}T00:00:00Z`).getUTCDay();
    return !cfg.weekend.includes(dow) && !cfg.holidays.has(key);
  });
}

/**
 * period  { key, from, to } (see utils/period.js), or a 'YYYY-MM' pay month
 * users   [{ _id, name, employeeId, department, baseSalary, joinDate }]
 * records Attendance docs (or plain objects) for the month: { user, date, checkIn, status, leaveType }
 * today   'YYYY-MM-DD' (server date). Days from today onwards are not judged yet.
 * s       settings (see above)
 * adjustments [{ user, month, type: 'earning'|'deduction', label, amount, note }] for this month
 */
function computePayroll(periodIn, users, records, today, s, adjustments = []) {
  const cfg = payrollCfg(s);
  const period = typeof periodIn === 'string' ? monthPeriod(periodIn, s.payrollStartDay) : periodIn;
  const month = period.key;
  const workingDays = workingDaysIn(period.from, period.to, cfg);
  const totalWorkingDays = workingDays.length;
  const wdSet = new Set(workingDays);

  const byUser = new Map();
  for (const r of records) {
    const id = String(r.user?._id || r.user);
    if (!byUser.has(id)) byUser.set(id, new Map());
    byUser.get(id).set(r.date, r);
  }

  const adjByUser = new Map();
  for (const a of adjustments) {
    // a dated entry counts in the period that contains its day; an older undated one belongs to its period key
    if (a.date) { if (a.date < period.from || a.date > period.to) continue; }
    else if (a.month && a.month !== month) continue;
    const id = String(a.user?._id || a.user);
    if (!adjByUser.has(id)) adjByUser.set(id, []);
    adjByUser.get(id).push(a);
  }

  // a half-day leave / absence: half the day off, the other half worked
  const isHalf = (r) => !!r && r.halfDay === true && (r.status === 'leave' || r.status === 'absent');

  const rows = users.map((u) => {
    const recs = byUser.get(String(u._id)) || new Map();
    const payType = ['daily', 'hourly'].includes(u.payType) ? u.payType : 'monthly';
    const rate = Number(u.baseSalary) || 0;

    let basic; // pay earned before deductions
    let dailyRate;
    let counted = 0; // working days that are in scope for this employee
    let worked = 0;
    let paidLeave = 0;
    let unpaidLeave = 0;
    let absent = 0;
    let late = 0;
    let hours = 0;
    let paidDays = 0;
    const method = payType === 'monthly' ? (u.monthlyMethod === 'fixed' || u.monthlyMethod === 'days' ? u.monthlyMethod : cfg.monthlyMethod) : '';

    if (payType === 'monthly') {
      basic = rate; // fixed salary; only absences, unpaid leave and late arrivals are deducted
      dailyRate = totalWorkingDays ? rate / totalWorkingDays : 0;
      for (const date of workingDays) {
        if (u.joinDate && date < u.joinDate) continue; // not employed yet
        counted += 1;
        const r = recs.get(date);

        if (isHalf(r)) {
          worked += 0.5;
          if (r.status === 'leave') {
            if (r.leaveType === 'unpaid') unpaidLeave += 0.5;
            else paidLeave += 0.5;
          } else absent += 0.5;
          continue;
        }
        // Leave / absence marked by the admin wins, even if the person had checked in that day
        // (a normal check-in turns the status into present / late, so this only happens when an admin marks it)
        if (r?.status === 'leave') {
          if (r.leaveType === 'unpaid') unpaidLeave += 1;
          else paidLeave += 1;
          continue;
        }
        if (r?.checkIn && r.status === 'absent') {
          absent += 1;
          continue;
        }
        if (r?.checkIn) {
          worked += 1;
          if (r.status === 'late') late += 1;
          continue;
        }
        // Today and future days are not judged: the person may still check in
        if (date >= today && r?.status !== 'absent') continue;
        absent += 1;
      }
      // 'days' method: paid only for the days present (and paid leave) at salary / working days
      if (method === 'days') {
        paidDays = worked + paidLeave;
        basic = dailyRate * paidDays;
      }
    } else {
      // Paid only for what was worked: every working day with a check-in counts (weekends and holidays are OT, see below),
      // and approved paid leave is paid as a normal day. Absences simply earn nothing.
      let minutes = 0;
      for (const [date, r] of recs) {
        if (u.joinDate && date < u.joinDate) continue;
        if (!wdSet.has(date)) continue; // weekend / holiday attendance is paid as OT once the admin accepts it (below)
        if (isHalf(r)) {
          worked += 0.5;
          minutes += Number(r.workedMinutes) || 0;
          if (r.status === 'leave' && r.leaveType !== 'unpaid') paidLeave += 0.5;
        } else if (r.status === 'leave' || (r.status === 'absent' && r.checkIn)) {
          // marked by the admin: wins over a check-in on the same day
          if (r.status === 'leave' && r.leaveType !== 'unpaid') paidLeave += 1;
        } else if (r.checkIn) {
          worked += 1;
          if (r.status === 'late') late += 1;
          minutes += Number(r.workedMinutes) || 0;
        }
      }
      counted = totalWorkingDays;
      hours = round2(minutes / 60);
      paidDays = worked + paidLeave;
      if (payType === 'daily') {
        dailyRate = rate;
        basic = rate * paidDays;
      } else {
        dailyRate = rate * cfg.hoursPerDay; // what one normal day is worth
        basic = rate * (minutes / 60) + paidLeave * dailyRate;
      }
    }
    basic = round2(basic);

    const lateBlocks = cfg.lateThreshold ? Math.floor(late / cfg.lateThreshold) : 0;
    const lateDeductionDays = lateBlocks * cfg.lateDays;
    // monthly: absences and unpaid leave are deducted from the fixed salary; daily/hourly: they are just not paid
    const deductionDays = (method === 'fixed' ? absent * cfg.factor + unpaidLeave : 0) + lateDeductionDays;
    const deduction = round2(Math.min(deductionDays * dailyRate, basic));

    // weekend / holiday attendance: paid as OT only when the admin accepted it
    let otAmount = 0;
    let otDays = 0;
    let otHours = 0;
    let otPending = 0;
    let otRejected = 0;
    for (const [date, r] of recs) {
      if (!isOtCandidate(r, date, wdSet, u, period)) continue;
      if (r.otStatus === 'accepted') {
        otAmount += otPay({ payType, rate, dailyRate }, r, cfg.otMultiplier);
        if (payType === 'hourly') otHours += ((Number(r.workedMinutes) || 0) / 60) * otShare(r);
        else otDays += otShare(r);
      } else if (r.otStatus === 'rejected') otRejected += 1;
      else otPending += 1;
    }

    // extra earnings (overtime, incentive ...) and extra deductions (advance ...)
    const adj = (adjByUser.get(String(u._id)) || []).slice().sort((x, y) => String(x.date || '').localeCompare(String(y.date || ''))).map((a) => ({
      id: a._id, date: a.date || '', type: a.type, label: a.label, amount: round2(Number(a.amount) || 0), note: a.note || '',
    }));
    if (otAmount > 0) {
      const times = cfg.otMultiplier !== 1 ? ` x ${cfg.otMultiplier}` : '';
      adj.push({
        auto: true, date: '', type: 'earning', label: 'Holiday OT', amount: round2(otAmount),
        note: payType === 'hourly' ? `${round2(otHours)} h on weekends / holidays${times}` : `${round2(otDays)} day${round2(otDays) === 1 ? '' : 's'} on weekends / holidays${times}`,
      });
    }
    // attendance % = days worked / working days that have passed so far (the whole period once it has ended)
    const soFar = workingDays.filter((d) => d <= today && !(u.joinDate && d < u.joinDate)).length;
    const attendancePct = soFar ? Math.min(100, Math.round((worked / soFar) * 100)) : 0;
    const additions = round2(adj.filter((a) => a.type === 'earning').reduce((t, a) => t + a.amount, 0));
    const otherDeductions = round2(adj.filter((a) => a.type === 'deduction').reduce((t, a) => t + a.amount, 0));
    const rawNet = round2(basic - deduction + additions - otherDeductions);
    return {
      userId: u._id,
      name: u.name,
      employeeId: u.employeeId || '',
      department: u.department || '',
      phone: u.phone || '', // WhatsApp number, to send the salary details
      payType,
      payMethod: method, // monthly staff: 'fixed' or 'days'
      rate: round2(rate), // monthly salary, rate per day or rate per hour, depending on payType
      baseSalary: basic, // pay earned before deductions (= the salary for monthly staff)
      paidDays, // daily and hourly staff: days worked + paid leave
      hours, // hourly staff: hours worked
      workingDays: counted,
      workingDaysSoFar: soFar, // working days that have passed (counted for the attendance %)
      attendancePct,
      worked,
      paidLeave,
      unpaidLeave,
      absent,
      late,
      lateDeductionDays,
      dailyRate: round2(dailyRate),
      deduction,
      additions,
      otherDeductions,
      otDays: payType === 'hourly' ? 0 : round2(otDays), // accepted weekend / holiday days
      otPending, // weekend / holiday attendances waiting for the admin
      otRejected,
      adjustments: adj,
      netSalary: Math.max(0, rawNet),
      // when advances etc. are bigger than what is owed, the rest is not paid out as a negative
      shortfall: rawNet < 0 ? round2(-rawNet) : 0,
    };
  });

  const totals = rows.reduce(
    (t, r) => ({
      baseSalary: round2(t.baseSalary + r.baseSalary),
      deduction: round2(t.deduction + r.deduction),
      additions: round2(t.additions + r.additions),
      otherDeductions: round2(t.otherDeductions + r.otherDeductions),
      netSalary: round2(t.netSalary + r.netSalary),
    }),
    { baseSalary: 0, deduction: 0, additions: 0, otherDeductions: 0, netSalary: 0 }
  );

  return {
    month,
    from: period.from,
    to: period.to,
    custom: !!period.custom,
    currency: cfg.currency,
    totalWorkingDays,
    deductionFactor: cfg.factor,
    lateThreshold: cfg.lateThreshold,
    lateDays: cfg.lateDays,
    hoursPerDay: cfg.hoursPerDay,
    // true while the month is still running: figures are "so far", not final
    inProgress: today <= period.to,
    otPending: rows.reduce((t, r) => t + r.otPending, 0),
    rows,
    totals,
  };
}

module.exports = { computePayroll, workingDaysIn, payrollCfg, isOffDay, isOtCandidate, otPay };
