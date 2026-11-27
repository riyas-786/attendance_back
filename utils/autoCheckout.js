// Closes check-ins that staff forgot to close.
// Runs every few minutes (see server.js). A check-in that is still open after the cut-off time is closed
// at the end of that person's shift, or after "N hours" when they have no shift end, and marked "auto"
// so the admin can see it and correct it (Overview -> Set check-out).

const Attendance = require('../models/Attendance');
const User = require('../models/User');
const { getSettings } = require('./settings');
const { resolveRules } = require('./rules');
const { normalize, openSession, recompute } = require('./sessions');

const HOUR = 3600 * 1000;
const keyOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; // server time = company time zone

// the moment HH:MM on a calendar day (plus whole days), in the company time zone
function at(dateKey, hhmm, plusDays = 0) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(y, m - 1, d + plusDays, Number(hhmm.slice(0, 2)), Number(hhmm.slice(3, 5)), 0, 0);
}

/**
 * Should this open check-in be closed now, and at what time?
 *   dateKey  the day of the record (YYYY-MM-DD)
 *   inAt     when the check-in happened
 *   rules    { workEnd: 'HH:MM' | '', overnight: boolean }  (from resolveRules)
 *   cfg      { autoCheckoutTime, autoCheckoutHours }
 * Returns the Date to close it at, or null to leave it alone for now.
 */
function closeTimeFor(dateKey, inAt, rules, cfg, now = new Date()) {
  const hours = Number(cfg.autoCheckoutHours) > 0 ? Number(cfg.autoCheckoutHours) : 9;
  const hasEnd = !!rules.workEnd;
  let eligibleAt;
  let closeAt;

  if (rules.overnight && hasEnd) {
    // a shift that runs past midnight: it ends the next morning; wait 3 hours after that before closing
    closeAt = at(dateKey, rules.workEnd, 1);
    eligibleAt = new Date(closeAt.getTime() + 3 * HOUR);
  } else {
    eligibleAt = at(dateKey, cfg.autoCheckoutTime || '23:30');
    // checked in after the cut-off time: give it 3 more hours before closing
    if (eligibleAt <= inAt) eligibleAt = new Date(inAt.getTime() + 3 * HOUR);
    const shiftEnd = hasEnd ? at(dateKey, rules.workEnd) : null;
    // no usable shift end: N hours after the check-in, but not later than the cut-off
    closeAt = shiftEnd && shiftEnd > inAt ? shiftEnd : new Date(Math.min(inAt.getTime() + hours * HOUR, eligibleAt.getTime()));
  }

  if (now < eligibleAt) return null; // not yet
  if (closeAt < inAt) closeAt = inAt;
  if (closeAt > now) closeAt = now; // never in the future
  return closeAt;
}

// Close every forgotten check-in of the last 35 days that is due. Returns how many were closed.
async function sweep(now = new Date()) {
  const cfg = await getSettings();
  if (!cfg.autoCheckoutEnabled) return 0;

  const fromKey = keyOf(new Date(now.getTime() - 35 * 24 * HOUR));
  const records = await Attendance.find({
    date: { $gte: fromKey },
    $or: [
      { sessions: { $elemMatch: { out: null } } },
      { sessions: { $size: 0 }, checkIn: { $ne: null }, checkOut: null }, // records saved before several sessions existed
    ],
  });

  let closed = 0;
  const rulesCache = new Map();
  for (const rec of records) {
    normalize(rec);
    const open = openSession(rec);
    if (!open) continue;
    let rules = rulesCache.get(String(rec.user));
    if (!rules) {
      const user = await User.findById(rec.user);
      if (!user) continue;
      rules = await resolveRules(user);
      rulesCache.set(String(rec.user), rules);
    }
    const closeAt = closeTimeFor(rec.date, new Date(open.in), rules, cfg, now);
    if (!closeAt) continue;
    open.out = closeAt;
    open.outMethod = 'auto';
    recompute(rec);
    await rec.save();
    closed += 1;
  }
  return closed;
}

module.exports = { sweep, closeTimeFor };
