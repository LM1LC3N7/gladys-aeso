// -----------------------------------------------------------------------------
// Mountain Prevailing Time (America/Edmonton): the AESO settlement days run
// from local midnight to local midnight. Alberta keeps UTC-6 all year since
// 1 November 2026 (tz database 2026e); before, a day had 23 settlement hours
// on the spring change and 25 on the autumn one, which the history still
// has. Edmonton is a whole number of hours behind UTC (7 or 6), so a local
// hour is a UTC hour. The days follow the tz database of the Node.js of the
// image: TZ_CURRENT tells whether it knows the 2026 change. Pure.
// -----------------------------------------------------------------------------

import { TIMEZONE } from './constants.js';

export const MINUTE = 60_000;
export const HALF_HOUR = 30 * MINUTE;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const two = (n) => String(n).padStart(2, '0');

/** `{ year, month, day, hour, minute }` of the instant `t` (epoch ms) in Edmonton. */
export function mountain(t) {
  const parts = {};
  for (const { type, value } of formatter.formatToParts(new Date(t))) {
    if (type !== 'literal') parts[type] = Number(value);
  }
  return parts;
}

/** The local day `YYYY-MM-DD` of the instant `t`. */
export function dayOf(t) {
  const p = mountain(t);
  return `${p.year}-${two(p.month)}-${two(p.day)}`;
}

export const DAY_PATTERN = /^20\d\d-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** The day `n` days after `day` (calendar days, whatever their length). */
export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${two(t.getUTCMonth() + 1)}-${two(t.getUTCDate())}`;
}

/** The instant of the local midnight starting `day` (Edmonton is UTC-7 or UTC-6 then). */
export function dayStart(day) {
  const [y, m, d] = day.split('-').map(Number);
  for (const offset of [7, 6]) {
    const t = Date.UTC(y, m - 1, d) + offset * HOUR;
    const p = mountain(t);
    if (p.year === y && p.month === m && p.day === d && p.hour === 0 && p.minute === 0) return t;
  }
  throw new RangeError(`No local midnight for ${day}`);
}

/**
 * Whether the tz database knows that Alberta keeps UTC-6 all year from
 * November 2026 (2026e or later). An older one puts every winter hour an hour
 * off the AESO's own MPT times: the module then asks nothing.
 */
export const TZ_CURRENT = (() => {
  const p = mountain(Date.UTC(2027, 0, 15, 12));
  return p.hour === 6 && p.day === 15;
})();

/** The settlement hours of a local day: 24 (23 or 25 on a clock change). */
export const hoursOf = (day) => (dayStart(addDays(day, 1)) - dayStart(day)) / HOUR;

/** The days from `first` to `last`, both included (none when `last` is before `first`). */
export function daysBetween(first, last) {
  const days = [];
  for (let day = first; day <= last && days.length < 10_000; day = addDays(day, 1)) days.push(day);
  return days;
}

/** `YYYY-MM-DD HH:MM` in Edmonton: the texts shown, and the `begin_datetime_mpt` of the API. */
export function localText(t) {
  const p = mountain(t);
  return `${p.year}-${two(p.month)}-${two(p.day)} ${two(p.hour)}:${two(p.minute)}`;
}
