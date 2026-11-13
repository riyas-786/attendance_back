// Pay periods.
//
// A "pay month" is named after the month it ENDS in (like a payslip: "Nov 2026").
//  - start day 1 (default): the calendar month, 1 Nov - 30 Nov.
//  - start day 20:          20 Oct - 19 Nov, named "2026-11".
// A custom range (any two dates) is also possible; its key is "YYYY-MM-DD..YYYY-MM-DD".

const pad = (n) => String(n).padStart(2, '0');
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RANGE_RE = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/;
const MAX_DAYS = 93;

function isRealDate(s) {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const clampStart = (n) => {
  const x = Math.floor(Number(n));
  return Number.isFinite(x) && x >= 1 && x <= 28 ? x : 1;
};

function monthPeriod(key, startDay) {
  const sd = clampStart(startDay);
  const [y, m] = key.split('-').map(Number);
  if (sd === 1) {
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { key, from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(last)}`, custom: false };
  }
  const prev = new Date(Date.UTC(y, m - 2, 1)); // month before
  return {
    key,
    from: `${prev.getUTCFullYear()}-${pad(prev.getUTCMonth() + 1)}-${pad(sd)}`,
    to: `${y}-${pad(m)}-${pad(sd - 1)}`,
    custom: false,
  };
}

function rangePeriod(from, to) {
  if (!isRealDate(from) || !isRealDate(to)) return { error: 'Dates must be real dates (YYYY-MM-DD)' };
  if (from > to) return { error: 'The start date must be on or before the end date' };
  const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
  if (days > MAX_DAYS) return { error: `A period can be at most ${MAX_DAYS} days` };
  return { key: `${from}..${to}`, from, to, custom: true };
}

// The pay month whose period contains `today` (YYYY-MM-DD)
function currentKey(today, startDay) {
  const sd = clampStart(startDay);
  let [y, m, d] = today.split('-').map(Number);
  if (sd > 1 && d >= sd) { m += 1; if (m > 12) { m = 1; y += 1; } }
  return `${y}-${pad(m)}`;
}

/**
 * Works out the period from request values: ?from=&to= (custom), ?month= (pay month) or nothing (current).
 * Returns the period object or { error }.
 */
function resolvePeriod({ month, from, to } = {}, startDay, today) {
  if (from || to) return rangePeriod(String(from || ''), String(to || ''));
  const key = month || currentKey(today, startDay);
  const r = RANGE_RE.exec(key);
  if (r) return rangePeriod(r[1], r[2]);
  if (!MONTH_RE.test(key)) return { error: 'month must be YYYY-MM' };
  return monthPeriod(key, startDay);
}

// Every date key from..to inclusive
function datesBetween(from, to) {
  const out = [];
  const end = Date.parse(to);
  for (let t = Date.parse(from); t <= end; t += 86400000) {
    const d = new Date(t);
    out.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`);
  }
  return out;
}

const isPeriodKey = (k) => MONTH_RE.test(k) || (RANGE_RE.test(k) && !rangePeriod(...RANGE_RE.exec(k).slice(1, 3)).error);

module.exports = { isRealDate, monthPeriod, rangePeriod, currentKey, resolvePeriod, datesBetween, isPeriodKey, clampStart };
