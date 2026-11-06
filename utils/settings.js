// Admin-editable settings.
//
// The values the admin saves on the Settings page are stored in MongoDB (models/Settings.js).
// getSettings() returns them merged over the .env defaults, so .env only provides the starting
// values until the admin saves the page. Every route calls getSettings() per request, so changes
// apply immediately with no restart.

const ENV = {
  workStart: 'WORK_START',
  lateGraceMinutes: 'LATE_GRACE_MINUTES',
  officeLat: 'OFFICE_LAT',
  officeLng: 'OFFICE_LNG',
  officeRadiusMeters: 'OFFICE_RADIUS_METERS',
  requireQr: 'REQUIRE_QR',
  qrWindowMinutes: 'QR_WINDOW_MINUTES',
  frontendUrl: 'FRONTEND_URL',
  weekendDays: 'WEEKEND_DAYS',
  holidays: 'HOLIDAYS',
  absentDeductionFactor: 'ABSENT_DEDUCTION_FACTOR',
  lateCountThreshold: 'LATE_COUNT_THRESHOLD',
  lateDeductionDays: 'LATE_DEDUCTION_DAYS',
  salaryCurrency: 'SALARY_CURRENCY',
};

const num = (v, fallback) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : fallback;
};
const optNum = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

// Defaults taken from .env (used for anything the admin has not saved yet)
function envDefaults() {
  const e = process.env;
  return {
    workStart: e.WORK_START || '09:00',
    lateGraceMinutes: num(e.LATE_GRACE_MINUTES, 0),
    officeLat: optNum(e.OFFICE_LAT),
    officeLng: optNum(e.OFFICE_LNG),
    officeRadiusMeters: num(e.OFFICE_RADIUS_METERS, 200),
    requireQr: String(e.REQUIRE_QR).toLowerCase() === 'true',
    qrWindowMinutes: num(e.QR_WINDOW_MINUTES, 5),
    frontendUrl: e.FRONTEND_URL || 'http://localhost:4200',
    weekendDays: (e.WEEKEND_DAYS ?? '0,6').split(',').map((s) => s.trim()).filter((s) => s !== '').map(Number),
    holidays: (e.HOLIDAYS || '').split(',').map((s) => s.trim()).filter(Boolean).sort(),
    absentDeductionFactor: num(e.ABSENT_DEDUCTION_FACTOR, 1),
    lateCountThreshold: num(e.LATE_COUNT_THRESHOLD, 3),
    lateDeductionDays: num(e.LATE_DEDUCTION_DAYS, 0.5),
    salaryCurrency: e.SALARY_CURRENCY || 'AED',
  };
}

function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const toNumOrNull = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

/**
 * Validates a (possibly partial) settings object on top of the current values.
 * Returns { values } or { error }.
 */
function validate(input = {}, base = envDefaults()) {
  const v = { ...base };
  const has = (k) => input[k] !== undefined;

  if (has('workStart')) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(input.workStart))) return { error: 'Work start time must be HH:MM (24-hour)' };
    v.workStart = input.workStart;
  }
  if (has('lateGraceMinutes')) {
    const n = Number(input.lateGraceMinutes);
    if (!Number.isInteger(n) || n < 0 || n > 240) return { error: 'Grace period must be a whole number from 0 to 240 minutes' };
    v.lateGraceMinutes = n;
  }

  if (has('officeLat')) v.officeLat = toNumOrNull(input.officeLat);
  if (has('officeLng')) v.officeLng = toNumOrNull(input.officeLng);
  if ((v.officeLat === null) !== (v.officeLng === null)) return { error: 'Enter both office latitude and longitude, or leave both empty' };
  if (v.officeLat !== null) {
    if (!isNum(v.officeLat) || v.officeLat < -90 || v.officeLat > 90) return { error: 'Latitude must be between -90 and 90' };
    if (!isNum(v.officeLng) || v.officeLng < -180 || v.officeLng > 180) return { error: 'Longitude must be between -180 and 180' };
  }
  if (has('officeRadiusMeters')) {
    const n = Number(input.officeRadiusMeters);
    if (!isNum(n) || n < 10 || n > 100000) return { error: 'Allowed distance must be between 10 and 100000 metres' };
    v.officeRadiusMeters = n;
  }

  if (has('requireQr')) {
    if (typeof input.requireQr !== 'boolean') return { error: 'Require QR must be true or false' };
    v.requireQr = input.requireQr;
  }
  if (has('qrWindowMinutes')) {
    const n = Number(input.qrWindowMinutes);
    if (!Number.isInteger(n) || n < 1 || n > 60) return { error: 'QR refresh time must be a whole number from 1 to 60 minutes' };
    v.qrWindowMinutes = n;
  }
  if (has('frontendUrl')) {
    const u = String(input.frontendUrl).trim();
    if (!/^https?:\/\/[^\s]+$/i.test(u)) return { error: 'App address must start with http:// or https://' };
    v.frontendUrl = u.replace(/\/+$/, '');
  }

  if (has('weekendDays')) {
    const d = input.weekendDays;
    if (!Array.isArray(d) || d.some((x) => !Number.isInteger(x) || x < 0 || x > 6)) return { error: 'Weekend days must be numbers from 0 (Sunday) to 6 (Saturday)' };
    v.weekendDays = [...new Set(d)].sort((a, b) => a - b);
  }
  if (has('holidays')) {
    const h = input.holidays;
    if (!Array.isArray(h) || h.some((x) => typeof x !== 'string' || !isRealDate(x))) return { error: 'Each holiday must be a real date (YYYY-MM-DD)' };
    v.holidays = [...new Set(h)].sort();
  }

  if (has('absentDeductionFactor')) {
    const n = Number(input.absentDeductionFactor);
    if (!isNum(n) || n < 0 || n > 10) return { error: 'Absent deduction must be between 0 and 10 days' };
    v.absentDeductionFactor = n;
  }
  if (has('lateCountThreshold')) {
    const n = Number(input.lateCountThreshold);
    if (!Number.isInteger(n) || n < 0 || n > 100) return { error: 'Late arrivals per penalty must be a whole number from 0 to 100 (0 = off)' };
    v.lateCountThreshold = n;
  }
  if (has('lateDeductionDays')) {
    const n = Number(input.lateDeductionDays);
    if (!isNum(n) || n < 0 || n > 10) return { error: 'Late deduction must be between 0 and 10 days' };
    v.lateDeductionDays = n;
  }
  if (has('salaryCurrency')) {
    const c = String(input.salaryCurrency).trim();
    if (!c || c.length > 8) return { error: 'Currency must be 1 to 8 characters' };
    v.salaryCurrency = c;
  }
  return { values: v };
}

// ---- database ----

const model = () => require('../models/Settings');

// Effective settings: admin-saved values override the .env defaults
async function getSettings() {
  const out = envDefaults();
  const doc = await model().findOne({ key: 'main' }).lean();
  if (!doc) return out;
  for (const k of Object.keys(ENV)) if (doc[k] !== undefined) out[k] = doc[k];
  return out;
}

// Validates on top of the current settings (so a partial update is fine) and stores the full result
async function saveSettings(input) {
  const { values, error } = validate(input, await getSettings());
  if (error) return { error };
  await model().findOneAndUpdate(
    { key: 'main' },
    { $set: { key: 'main', ...values } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return { values };
}

module.exports = { getSettings, saveSettings, validate, envDefaults };
