// -----------------------------------------------------------------------------
// Keys shared with the manifest, the data source and the bounds. The manifest
// keys (template, inputs, calendar, action) are forever: contracts and users
// store them.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const VERSION = pkg.version;
export const USER_AGENT = `gladys-aeso/${VERSION} (+https://github.com/LM1LC3N7/gladys-aeso)`;

/**
 * The Pool Price Report of the AESO public API (Azure API Management gateway,
 * product "public", version 1.1): `?startDate=&endDate=` (yyyy-MM-dd, both
 * included), the settlement hours of those days, the price in CAD/MWh. The key
 * goes in the `API-KEY` header (never in the query string: it would end up in
 * logs). A 404 or 410 here means the AESO retired this version.
 */
export const API_URL = 'https://apimgw.aeso.ca/public/poolprice-api/v1.1/price/poolPrice';
export const API_KEY_HEADER = 'API-KEY';

/** Mountain Prevailing Time: the settlement days run from local midnight to local midnight. */
export const TIMEZONE = 'America/Edmonton';
export const CURRENCY = 'CAD';

/** The template users pick in the contract wizard (rules mode, priced by the core). */
export const TEMPLATE = 'aeso-pool-price';
/** The price calendar the integration feeds (no provider prefix: any Alberta pool price feed). */
export const CALENDAR = 'spot-ca-ab';
/** The configuration button. */
export const ACTION_TEST = 'test_key';
/** The configuration key of the API key. */
export const CONFIG_KEY = 'api_key';

export const INPUTS = {
  ADDER: 'adder_cad_kwh',
  DELIVERY: 'delivery_cad_kwh',
  PROVISIONAL: 'provisional_cad_kwh',
  FIXED: 'fixed_cad_month',
  GST: 'gst_percent',
};

// --- Bounds ------------------------------------------------------------------

export const HTTP_TIMEOUT = 20_000;
/** One request covers at most this many local days (31 x 24 rows, about 110 KB). */
export const MAX_DAYS_PER_REQUEST = 31;
/** More than this is not the published report. */
export const MAX_ANSWER_BYTES = 1024 * 1024;
/** Rows read from one answer (31 days of 25 hours is 775). */
export const MAX_ROWS = 1000;
/**
 * The market rules bound the pool price to 0 .. 999.99 CAD/MWh; a value
 * outside -1,000 .. 3,000 CAD/MWh is not a pool price (an error, another
 * unit): that hour stays unknown. The wider range leaves room for a change of
 * the rules (a negative floor) without guessing.
 */
export const MIN_PRICE_MWH = -1000;
export const MAX_PRICE_MWH = 3000;
/** Local days kept in memory and /data (a year and a month). */
export const KEEP_DAYS = 400;
/** Days read back from today at the first start (a whole billing period and more). */
export const BACKFILL_DAYS = 35;
/** The API key: printable ASCII, no space, this many characters at most. */
export const MAX_KEY_LENGTH = 128;
export const MIN_KEY_LENGTH = 8;
/** The /data state file read back at most this size (larger: not ours). */
export const MAX_STATE_BYTES = 4 * 1024 * 1024;
/** Entries in one calendar publication (the core takes 2,000 at most). */
export const CALENDAR_BATCH = 2000;
/** Contracts read for the status and the backfill. */
export const MAX_CONTRACTS = 100;

// --- Schedule ----------------------------------------------------------------

/**
 * The pool price of an hour is known once the hour has ended: the module
 * asks for it this long after the end of the hour.
 */
export const PUBLISH_DELAY = 5 * 60_000;
/** An hour expected and still absent from the answer: asked again 10 minutes later. */
export const WAIT_PUBLICATION = 10 * 60_000;
/** A past day the API answered incomplete: asked again a day later. */
export const EMPTY_RETRY = 24 * 60 * 60_000;
/** After a failed request: 5, 15, 30, 60 minutes, then every 3 hours (MAX_RETRY caps the steps). */
export const RETRY_STEPS = [5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000, 3 * 60 * 60_000];
export const MAX_RETRY = 6 * 60 * 60_000;
/** The version retired (404, 410): asked again every 6 hours, the update of the module is due. */
export const RETIRED_RETRY = 6 * 60 * 60_000;
/** A 429 (or a 403 quota): its Retry-After within these bounds (10 minutes when absent). */
export const PAUSE_MIN = 60_000;
export const PAUSE_MAX = 6 * 60 * 60_000;
export const PAUSE_DEFAULT = 10 * 60_000;
/** Two requests never leave closer than this (the button included). */
export const MIN_GAP = 60_000;
/** /data unreadable (not missing): read again on this period. */
export const STORE_RETRY = 10_000;
/** getConfig() failed: asked again after 10 s, doubling up to 5 minutes, for ever. */
export const CONFIG_RETRY = 10_000;
export const CONFIG_RETRY_MAX = 5 * 60_000;
/** A write of /data longer than this counts as failed (the data stays in memory). */
export const SAVE_TIMEOUT = 10_000;
/** A status publication longer than this is given up (the next one goes on). */
export const STATUS_TIMEOUT = 10_000;
/** A calendar publication longer than this is given up (retried at the next check). */
export const CALENDAR_TIMEOUT = 20_000;
/** The schedule never sleeps longer than this (a wall clock that jumps is caught up). */
export const MAX_SLEEP = 60 * 60_000;
/** Contracts read again at most this often (status and backfill only). */
export const CONTRACTS_EVERY = 60 * 60_000;
