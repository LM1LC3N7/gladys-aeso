// -----------------------------------------------------------------------------
// A fictional AESO Pool Price Report in the real layout (the `return`
// envelope, the fields as strings, the hours not settled with an empty pool
// price and a forecast). The prices are made-up numbers, a function of the
// hour, so a test knows the price of any hour.
// -----------------------------------------------------------------------------

import { addDays, dayStart, hoursOf, localText } from '../../src/time.js';

const HOUR = 3_600_000;
const two = (n) => String(n).padStart(2, '0');

/** `YYYY-MM-DD HH:MM` in UTC. */
export function utcText(t) {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

/** The made-up pool price (CAD/MWh, two decimals) of the hour starting at `t`. */
export const priceAt = (t) => Number((12.5 + ((t / HOUR) % 97) * 1.37).toFixed(2));

/** The rows of one hour. */
export const row = (t, poolPrice) => ({
  begin_datetime_utc: utcText(t),
  begin_datetime_mpt: localText(t),
  pool_price: poolPrice,
  forecast_pool_price: '55.10',
  rolling_30day_avg: '61.87',
});

/**
 * The answer for local days `first` .. `last` at `now`: settled hours with
 * their price, the current hour and the next two with an empty price, nothing
 * later. `lag`: how long after its end an hour is settled.
 */
export function answer(first, last, now, { lag = 60_000, envelope = true } = {}) {
  const rows = [];
  for (let day = first; day <= last; day = addDays(day, 1)) {
    const start = dayStart(day);
    for (let k = 0; k < hoursOf(day); k += 1) {
      const t = start + k * HOUR;
      if (t > now + 2 * HOUR) break;
      rows.push(row(t, t + HOUR + lag <= now ? priceAt(t).toFixed(2) : ''));
    }
  }
  const report = { 'Pool Price Report': rows };
  return envelope ? { timestamp: utcText(now), responseCode: '200', return: report } : report;
}
