// Names the place where a check-in/out happened.
//
// For people whose location is checked, verifyPresence() already records the nearest allowed place.
// For everyone else (field/remote staff, or no location rule) the coordinates are still saved when the
// browser shares them, and this adds the name of any known location (or the default office) they are inside.

const { distanceMeters } = require('./presence');

async function labelLocation(location, cfg) {
  if (!location || location.siteName) return location;
  if (!Number.isFinite(location.lat) || !Number.isFinite(location.lng)) return location;
  try {
    const Location = require('../models/Location');
    const known = (await Location.find().lean()).map((l) => ({ name: l.name, lat: l.lat, lng: l.lng, radius: l.radiusMeters }));
    if (cfg && Number.isFinite(cfg.officeLat) && Number.isFinite(cfg.officeLng)) {
      known.push({ name: 'Default office', lat: cfg.officeLat, lng: cfg.officeLng, radius: Number(cfg.officeRadiusMeters) || 200 });
    }
    let best;
    for (const k of known) {
      const d = distanceMeters(k.lat, k.lng, location.lat, location.lng);
      if (d <= k.radius && (!best || d < best.d)) best = { k, d };
    }
    if (best) return { ...location, siteName: best.k.name, distanceM: Math.round(best.d) };
  } catch (err) {
    // naming the place is a nicety: never block a check-in because of it
  }
  return location;
}

module.exports = { labelLocation };
