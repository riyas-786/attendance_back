// Works out the rules that apply to ONE person: their duty time and where they may check in.
// Falls back to the global Settings when nothing is assigned to them.

const { getSettings } = require('./settings');

/**
 * Returns {
 *   cfg,            global settings
 *   workStart,      'HH:MM'
 *   graceMinutes,   number
 *   shiftName,      string | ''
 *   sites,          null  = no location check
 *                   array = must be within the radius of at least one of these [{ name, lat, lng, radius }]
 * }
 */
async function resolveRules(user) {
  const cfg = await getSettings();
  await user.populate([{ path: 'shift' }, { path: 'locations' }]);

  const shift = user.shift || null;
  const workStart = shift ? shift.workStart : cfg.workStart;
  const workEnd = shift ? shift.workEnd || '' : '';
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const overnight = !!workEnd && toMin(workEnd) <= toMin(workStart); // runs past midnight
  const graceMinutes = shift ? Number(shift.graceMinutes) || 0 : Number(cfg.lateGraceMinutes) || 0;

  let sites;
  if (user.anyLocation) {
    sites = null;
  } else if (user.locations && user.locations.length) {
    sites = user.locations.map((l) => ({ name: l.name, lat: l.lat, lng: l.lng, radius: l.radiusMeters }));
  } else if (cfg.officeLat !== null && cfg.officeLat !== undefined && cfg.officeLng !== null && cfg.officeLng !== undefined) {
    sites = [{ name: 'the office', lat: cfg.officeLat, lng: cfg.officeLng, radius: cfg.officeRadiusMeters }];
  } else {
    sites = null;
  }

  return { cfg, workStart, workEnd, overnight, graceMinutes, shiftName: shift ? shift.name : '', sites };
}

module.exports = { resolveRules };
