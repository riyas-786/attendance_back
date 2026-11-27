// Helpers for the several check-in/check-out sessions a person can have in one day.

const MAX_SESSIONS_PER_DAY = 20;
// Stops accidental double actions (e.g. pressing the button twice).
const MIN_SECONDS_BETWEEN_ACTIONS = 0; // no waiting between check-in and check-out (was 60)

const plain = (v) => (v && typeof v.toObject === 'function' ? v.toObject() : v);

// Records saved before multiple sessions existed only have checkIn/checkOut: turn them into one session.
function normalize(rec) {
  if (rec.sessions.length === 0 && rec.checkIn) {
    rec.sessions.push({
      in: rec.checkIn,
      out: rec.checkOut || undefined,
      inLocation: plain(rec.inLocation),
      outLocation: plain(rec.outLocation),
      inMethod: rec.inMethod || 'button',
    });
  }
  return rec;
}

// The session the person is currently in (checked in, not yet out), or null
function openSession(rec) {
  const last = rec.sessions[rec.sessions.length - 1];
  return last && !last.out ? last : null;
}

// Keep the day's summary fields in step with the sessions
function recompute(rec) {
  const s = rec.sessions;
  if (!s.length) {
    rec.checkIn = undefined;
    rec.checkOut = undefined;
    rec.workedMinutes = 0;
    return rec;
  }
  const first = s[0];
  const last = s[s.length - 1];
  rec.checkIn = first.in;
  rec.checkOut = last.out || undefined; // empty while checked in
  rec.inLocation = plain(first.inLocation);
  rec.inMethod = first.inMethod || 'button';
  rec.outLocation = last.out ? plain(last.outLocation) : undefined;
  rec.workedMinutes = s.reduce((t, x) => (x.out ? t + Math.max(0, Math.round((x.out - x.in) / 60000)) : t), 0);
  return rec;
}

// Seconds the person still has to wait before the next check-in/out is accepted (0 = go ahead)
function secondsToWait(rec, now = new Date()) {
  const last = rec.sessions[rec.sessions.length - 1];
  if (!last) return 0;
  const at = last.out || last.in;
  return Math.max(0, Math.ceil(MIN_SECONDS_BETWEEN_ACTIONS - (now - at) / 1000));
}

// Read-only list of {in, out} for reports (works for old and new records)
function listSessions(rec) {
  if (rec.sessions && rec.sessions.length) return rec.sessions.map((x) => ({ in: x.in, out: x.out, outMethod: x.outMethod }));
  return rec.checkIn ? [{ in: rec.checkIn, out: rec.checkOut }] : [];
}

// Like listSessions, plus where each check-in/out happened
function detailSessions(rec) {
  if (rec.sessions && rec.sessions.length) {
    return rec.sessions.map((x) => ({ in: x.in, out: x.out, inLocation: plain(x.inLocation), outLocation: plain(x.outLocation), inMethod: x.inMethod }));
  }
  return rec.checkIn
    ? [{ in: rec.checkIn, out: rec.checkOut, inLocation: plain(rec.inLocation), outLocation: plain(rec.outLocation), inMethod: rec.inMethod }]
    : [];
}

// Human-readable place for reports: "Head office (35 m)", "Unknown place (25.2, 55.3)", ...
function placeText(loc, method) {
  if (method === 'admin') return 'Added by admin';
  if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) return 'Location not shared';
  if (loc.siteName) return Number.isFinite(loc.distanceM) ? `${loc.siteName} (${loc.distanceM} m)` : loc.siteName;
  return `Unknown place (${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)})`;
}

const mapUrl = (loc) =>
  loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng) ? `https://www.google.com/maps?q=${loc.lat},${loc.lng}` : '';

module.exports = {
  MAX_SESSIONS_PER_DAY, MIN_SECONDS_BETWEEN_ACTIONS, normalize, openSession, recompute, secondsToWait,
  listSessions, detailSessions, placeText, mapUrl, plain,
};
