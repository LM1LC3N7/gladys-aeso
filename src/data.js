// -----------------------------------------------------------------------------
// Reading the answers of the AESO Pool Price Report (v1.1), never trusted:
//
//   { "timestamp": "…", "responseCode": "200",
//     "return": { "Pool Price Report": [
//       { "begin_datetime_utc": "2026-11-13 07:00",
//         "begin_datetime_mpt": "2026-11-13 00:00",
//         "pool_price": "45.67",
//         "forecast_pool_price": "44.1",
//         "rolling_30day_avg": "61.2" }, … ] } }
//
// (the OpenAPI example of the portal shows the report without the `return`
// envelope: both are read). An hour is kept only when its UTC start is an
// exact hour, its MPT start is the same instant on the Edmonton clock, the
// hour has ended, and the pool price is a plain decimal within -1,000 ..
// 3,000 CAD/MWh. An empty pool price (the current hour, the next ones, which
// only carry a forecast) is unknown, never zero. The forecast is never read.
// A non-numeric price for an hour ended less than an hour ago (a "-" placeholder)
// is "not settled yet", like an empty one. The UTC starts of the rows refused
// are returned (`bad`), so one unreadable hour can be told apart from a broken
// answer. A duplicate hour with another price leaves that hour unknown. Linear,
// bounded in rows, no prototype involved.
// -----------------------------------------------------------------------------

import { MAX_PRICE_MWH, MAX_ROWS, MIN_PRICE_MWH } from './constants.js';
import { HOUR, dayStart, hoursOf, localText } from './time.js';

export class DataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DataError';
  }
}

const STAMP = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)$/;
/** A plain decimal: no exponent, no sign other than a leading minus, no spaces. */
const DECIMAL = /^-?\d{1,6}(\.\d{1,6})?$/;

/** `YYYY-MM-DD HH:MM` read as a UTC instant on the hour; undefined otherwise. */
export function utcHour(value) {
  if (typeof value !== 'string') return undefined;
  const m = STAMP.exec(value);
  if (!m) return undefined;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (mi !== 0 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23) return undefined;
  const t = Date.UTC(y, mo - 1, d, h);
  // 2026-02-30 rolls over: refused.
  return new Date(t).getUTCDate() === d ? t : undefined;
}

/** The pool price (CAD/MWh) of a field: a number, or undefined when empty or unreadable. */
export function priceOf(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!DECIMAL.test(text)) return undefined;
  const price = Number(text);
  return Number.isFinite(price) && price >= MIN_PRICE_MWH && price <= MAX_PRICE_MWH
    ? price
    : undefined;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The rows of the report, from either envelope; a DataError when it is not the report. */
function rowsOf(json) {
  if (!isObject(json)) throw new DataError('not an object');
  let report = json;
  if (Object.hasOwn(json, 'return')) {
    if (Object.hasOwn(json, 'responseCode') && String(json.responseCode) !== '200') {
      throw new DataError(`responseCode ${String(json.responseCode).slice(0, 8)}`);
    }
    report = json.return;
  }
  if (!isObject(report) || !Object.hasOwn(report, 'Pool Price Report')) {
    throw new DataError('no Pool Price Report');
  }
  const rows = report['Pool Price Report'];
  if (!Array.isArray(rows)) throw new DataError('the report is not a list');
  if (rows.length > MAX_ROWS) throw new DataError(`more than ${MAX_ROWS} rows`);
  return rows;
}

/**
 * The hours of one answer: `{ hours: Map<start ms, CAD/MWh>, refused }`.
 * `now` (wall, epoch ms): an hour that has not ended is not taken.
 */
export function parseAnswer(json, now) {
  const rows = rowsOf(json);
  const hours = new Map();
  const conflicts = new Set();
  const bad = new Set();
  let refused = 0;
  for (const row of rows) {
    if (!isObject(row)) {
      refused += 1;
      continue;
    }
    const start = utcHour(row.begin_datetime_utc);
    if (start === undefined || row.begin_datetime_mpt !== localText(start)) {
      refused += 1;
      if (start !== undefined) bad.add(start);
      continue;
    }
    // Not settled yet: the current hour and the next ones carry a forecast only.
    if (start + HOUR > now) continue;
    const raw = row.pool_price;
    if (raw === '' || raw === null || raw === undefined) continue;
    const price = priceOf(raw);
    if (price === undefined) {
      // Just ended: a placeholder until the AESO settles it.
      if (start + 2 * HOUR > now) continue;
      refused += 1;
      bad.add(start);
      continue;
    }
    if (hours.has(start) && hours.get(start) !== price) conflicts.add(start);
    hours.set(start, price);
  }
  for (const start of conflicts) {
    hours.delete(start);
    refused += 1;
    bad.add(start);
  }
  return { hours, refused, bad };
}

/** The record of a local day from the hours of an answer: `{ start, prices, known }`. */
export function dayRecord(day, hours) {
  const start = dayStart(day);
  const count = hoursOf(day);
  const prices = [];
  let known = 0;
  for (let k = 0; k < count; k += 1) {
    const price = hours.get(start + k * HOUR);
    prices.push(price === undefined ? null : price);
    if (price !== undefined) known += 1;
  }
  return { start, prices, known };
}

/** A day read back from /data, checked like an answer; undefined when it does not read. */
export function restoreDay(day, value) {
  if (!Array.isArray(value) || value.length !== hoursOf(day)) return undefined;
  const prices = [];
  let known = 0;
  for (const price of value) {
    if (price === null) {
      prices.push(null);
    } else if (
      typeof price === 'number' &&
      Number.isFinite(price) &&
      price >= MIN_PRICE_MWH &&
      price <= MAX_PRICE_MWH
    ) {
      prices.push(price);
      known += 1;
    } else return undefined;
  }
  return { start: dayStart(day), prices, known };
}

/** Two records hold the same prices. */
export const sameDay = (a, b) =>
  Boolean(a && b) &&
  a.prices.length === b.prices.length &&
  a.prices.every((price, k) => price === b.prices[k]);

/** CAD/MWh -> CAD/kWh, without the noise of binary floats (the report has cents). */
export const perKwh = (mwh) => Math.round(mwh * 1e4) / 1e7;
