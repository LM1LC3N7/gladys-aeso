// -----------------------------------------------------------------------------
// The real clock (performance.now, setTimeout) sped up 2,000 times and a real
// local HTTP server: the settled hour is asked once an hour, never sooner, the
// key goes in its header, and nothing leaves after stop. Wide margins: a timer
// is late under load, never early.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { App } from '../src/app.js';
import { API_URL } from '../src/constants.js';
import { createMemoryStore } from '../src/store.js';
import { answer } from './fixtures/aeso.js';
import { measurePeriod, realClock, spyOn } from './helpers/clock.js';

const HOUR = 60 * 60_000;
const KEY = 'real-clock-key-0123456789';

test('real clock: the hour asked once an hour, nothing after stop', async (t) => {
  const clock = realClock({ speed: 2_000 });
  const requests = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const first = u.searchParams.get('startDate');
    const last = u.searchParams.get('endDate') ?? first;
    requests.push({ first, last, ua: req.headers['user-agent'], key: req.headers['api-key'] });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer(first, last, clock.now())));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const gladys = createFakeGladys({
    selector: 'aeso',
    config: { api_key: KEY },
    energyCalendars: { 'spot-ca-ab': [] },
  });
  const app = new App({
    gladys,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: createMemoryStore(),
    fetchImpl: (url, init) =>
      fetch(String(url).replace(API_URL, `${base}/poolPrice`), {
        ...init,
        signal: AbortSignal.timeout(5000),
      }),
  });
  t.after(async () => {
    await app.stop();
    clock.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const spy = spyOn(app, 'runCheck', clock);
  await gladys.connect();
  await app.connected();
  // The first check (backfill), then one an hour.
  const deadline = performance.now() + 30_000;
  while (spy.calls.length < 4 && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const hourly = { clock, calls: spy.calls.slice(1) };
  const gaps = await measurePeriod(hourly, { count: 3, period: HOUR, timeoutMs: 15_000 });
  assert.equal(gaps.length, 2);
  await app.idle();
  for (const r of requests.slice(-2)) assert.equal(r.first, r.last, 'one day an hour');
  assert.match(requests[0].ua, /^gladys-aeso\//);
  assert.equal(requests[0].key, KEY);
  await app.stop();
  const count = requests.length;
  const timers = clock.timersSet;
  await clock.sleep(3 * HOUR);
  assert.equal(requests.length, count, 'no request after stop');
  assert.equal(clock.timersSet, timers, 'no timer after stop');
});
