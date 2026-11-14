// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a scripted AESO API and a virtual
// clock (each read moves it 1 µs).
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { App } from '../../src/app.js';
import { API_URL, CALENDAR, TEMPLATE } from '../../src/constants.js';
import { registerHandlers } from '../../src/handlers.js';
import { createMemoryStore } from '../../src/store.js';
import { dayOf } from '../../src/time.js';
import { answer } from '../fixtures/aeso.js';
import { testClock } from './clock.js';

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
/** Saturday 14 November 2026, 11:20 local (UTC-6 all year now): the hour 10:00-11:00 is settled. */
export const NOW = Date.parse('2026-11-14T17:20:00Z');
export const KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/**
 * The API: `source.handler(request)` may return a Response, a body, 'timeout'
 * or undefined (the fictional answer at the clock's time).
 */
export function createSource(clock) {
  const source = { requests: [], handler: undefined, count: () => source.requests.length };
  source.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const first = u.searchParams.get('startDate');
    const request = {
      url: String(url),
      first,
      last: u.searchParams.get('endDate') ?? first,
      hasEnd: u.searchParams.has('endDate'),
      headers: init.headers ?? {},
      init,
      at: clock.now(),
    };
    source.requests.push(request);
    if (`${u.origin}${u.pathname}` !== API_URL) return new Response('nope', { status: 404 });
    let out = source.handler ? await source.handler(request) : undefined;
    if (out === 'timeout') {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    }
    if (out instanceof Response) return out;
    if (out === undefined) out = answer(request.first, request.last, clock.now());
    return json(out);
  };
  return source;
}

export const CONTRACT = {
  id: 'c1',
  template_key: TEMPLATE,
  template_version: '2026-11-14',
  pricing_mode: 'rules',
  inputs: { adder_cad_kwh: 0.01, provisional_cad_kwh: 0.1 },
  valid_from: '2026-11-01',
  valid_to: null,
  timezone: 'America/Edmonton',
  currency: 'CAD',
  billing_period_start_day: 1,
  status: 'active',
};

export async function setup({
  store = createMemoryStore(),
  now = NOW,
  config = { api_key: KEY },
  contracts = [CONTRACT],
  start = true,
  calendars = { [CALENDAR]: [] },
  handler,
} = {}) {
  const gladys = createFakeGladys({
    selector: 'aeso',
    config,
    energyContracts: contracts,
    energyCalendars: calendars,
  });
  const clock = testClock({ start: now });
  const source = createSource(clock);
  source.handler = handler;
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  const logger = { info: log, warn: log, error: log, debug: log };
  const app = new App({
    gladys,
    logger,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store,
    fetchImpl: source.fetch,
  });
  registerHandlers(gladys, app, logger);
  const wait = async (ms) => {
    await clock.advance(ms);
    await app.idle();
  };
  if (start) {
    await gladys.connect();
    await wait(0);
  }
  /** The calendar entries the fake Gladys holds. */
  const entries = () => gladys.fake.energyCalendars[CALENDAR] ?? [];
  const status = () => gladys.fake.connectionStatus;
  const today = () => dayOf(clock.now());
  return { app, gladys, clock, store, source, wait, lines, entries, status, today, logger };
}
