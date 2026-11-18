const crypto = require('crypto');

// All functions take `cfg`, the settings object from utils/settings.js getSettings().

// ---------- Location ----------

function officeConfig(cfg) {
  if (cfg.officeLat === null || cfg.officeLat === undefined || cfg.officeLng === null || cfg.officeLng === undefined) {
    return null;
  }
  return { lat: cfg.officeLat, lng: cfg.officeLng, radius: cfg.officeRadiusMeters };
}

// Great-circle distance in metres
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Checks the location rules for a check-in/out request.
 *
 * `sites` are the places THIS person may check in from: [{ name, lat, lng, radius }].
 *   - null / empty  -> no location check
 *   - otherwise     -> they must be within the radius of at least one site
 * When `sites` is left out, the single default office from the settings is used (old behaviour).
 *
 * Returns { ok: true, location, method } or { ok: false, status, message }.
 */
function verifyPresence(body = {}, cfg, sites) {
  const method = 'button';

  let location;
  if (sites === undefined) {
    const office = officeConfig(cfg);
    sites = office ? [{ name: 'the office', lat: office.lat, lng: office.lng, radius: office.radius }] : null;
  }
  const required = Array.isArray(sites) && sites.length > 0;
  const hasCoords = Number.isFinite(body.lat) && Number.isFinite(body.lng);

  let nearest;
  if (hasCoords) {
    location = { lat: body.lat, lng: body.lng, accuracy: body.accuracy };
    if (required) {
      for (const s of sites) {
        const d = Math.round(distanceMeters(s.lat, s.lng, body.lat, body.lng));
        if (!nearest || d < nearest.distance) nearest = { site: s, distance: d };
      }
      location.distanceM = nearest.distance;
      location.siteName = nearest.site.name;
    }
  }

  if (required) {
    if (!hasCoords) {
      return { ok: false, status: 400, message: 'Location is required. Please allow location access in your browser.' };
    }
    // inside the allowed radius of ANY of their sites
    const inside = sites.some((s) => distanceMeters(s.lat, s.lng, body.lat, body.lng) <= s.radius);
    if (!inside) {
      const where =
        sites.length === 1
          ? `${nearest.site.name}. You must be within ${nearest.site.radius} m`
          : `your nearest allowed place (${nearest.site.name}). You must be within ${nearest.site.radius} m of one of: ${sites.map((s) => s.name).join(', ')}`;
      return { ok: false, status: 403, message: `You are about ${nearest.distance} m from ${where}.` };
    }
  }

  return { ok: true, location, method };
}

module.exports = { verifyPresence, distanceMeters, officeConfig };
