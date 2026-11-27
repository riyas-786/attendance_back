// Automatic attendance for staff who do not use a smartphone (Staff -> Edit -> "Auto attendance").
//
// Every working day, for each active person marked auto:
//   - once their duty time has started: a check-in at the start of their shift (Settings default when no shift) is recorded;
//   - once their duty time has ended: the check-out is recorded at the end of the shift
//     (no shift end: start + "Hours in one paid day" from Settings).
// Days with ANY existing record are left alone, so leave, absence or a real check-in marked by the admin always wins.
// Weekends, holidays and days before the join date are skipped. Records are marked auto = true.

const Attendance = require('../models/Attendance');
const User = require('../models/User');
const { getSettings } = require('./settings');
const { resolveRules } = require('./rules');
const { recompute } = require('./sessions');

const DAY = 24 * 3600 * 1000;
const DAYS_BACK = 35;
const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; // server time = company time zone

function at(dateKey, hhmm, plusDays = 0) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(y, m - 1, d + plusDays, Number(hhmm.slice(0, 2)), Number(hhmm.slice(3, 5)), 0, 0);
}

function isOff(dateKey, cfg) {
  const dow = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
  return (cfg.weekendDays || []).includes(dow) || (cfg.holidays || []).includes(dateKey);
}

// When the shift of that day starts and ends: { start: Date, end: Date }
function shiftTimes(dateKey, rules, cfg) {
  const start = at(dateKey, rules.workStart);
  let end;
  if (rules.workEnd) end = at(dateKey, rules.workEnd, rules.overnight ? 1 : 0);
  else end = new Date(start.getTime() + (Number(cfg.payHoursPerDay) > 0 ? Number(cfg.payHoursPerDay) : 8) * 3600 * 1000);
  return { start, end };
}

async function sweep(now = new Date()) {
  const cfg = await getSettings();
  const users = await User.find({ role: 'staff', active: true, autoAttendance: true });
  if (!users.length) return 0;

  let changed = 0;
  for (const u of users) {
    const rules = await resolveRules(u);
    for (let i = DAYS_BACK; i >= 0; i--) {
      const date = keyOf(new Date(now.getTime() - i * DAY));
      if (isOff(date, cfg) || (u.joinDate && date < u.joinDate)) continue;
      const { start, end } = shiftTimes(date, rules, cfg);
      if (now < start) continue; // duty has not started yet

      let rec = await Attendance.findOne({ user: u._id, date });
      if (!rec) {
        rec = new Attendance({ user: u._id, date, status: 'present', auto: true, sessions: [{ in: start, inMethod: 'auto' }] });
        if (now >= end) rec.sessions[0].out = end, rec.sessions[0].outMethod = 'auto';
        recompute(rec);
        try { await rec.save(); changed += 1; } catch (e) { if (e.code !== 11000) throw e; } // saved meanwhile by someone else
        continue;
      }
      // close the open check-in we made earlier, once the shift is over (never touch anything an admin edited)
      const s = rec.sessions;
      if (rec.auto && rec.status === 'present' && s.length === 1 && s[0].inMethod === 'auto' && !s[0].out && now >= end) {
        s[0].out = end;
        s[0].outMethod = 'auto';
        recompute(rec);
        await rec.save();
        changed += 1;
      }
    }
  }
  return changed;
}

module.exports = { sweep, shiftTimes };
