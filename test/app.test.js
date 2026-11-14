// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a scripted AESO API and a virtual
// clock: when the API is asked (and never sooner), the key and its refusal,
// the pauses, /data, the calendar, the status, the button, secrets.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GladysApiError } from '@gladysassistant/integration-sdk';
import { App } from '../src/app.js';
import { CALENDAR, PAUSE_MAX } from '../src/constants.js';
import { perKwh } from '../src/data.js';
import { createMemoryStore } from '../src/store.js';
import { dayStart } from '../src/time.js';
import { answer, priceAt, row } from './fixtures/aeso.js';
import { CONTRACT, DAY, HOUR, KEY, MINUTE, NOW, SECOND, json, setup } from './helpers/app.js';

const text = (status) => `${status?.message?.en ?? ''} ${status?.message?.fr ?? ''}`;

test('first start: 35 days in two requests with the key in its header, the calendar fed in 30-minute slots', async () => {
  const store = createMemoryStore();
  const seen = [];
  const { source, entries, status, app } = await setup({
    store,
    handler: () => {
      // The attempt is in /data before the request leaves.
      seen.push(store.data?.attemptAt);
      return undefined;
    },
  });
  assert.ok(seen.length === 2 && seen.every((at) => typeof at === 'number'));
  assert.equal(source.count(), 2);
  const [first, second] = source.requests;
  assert.equal(first.first, '2026-10-15');
  assert.equal(first.last, '2026-11-14');
  assert.equal(second.first, '2026-10-11');
  assert.equal(second.last, '2026-10-14');
  for (const r of source.requests) {
    assert.equal(r.headers['API-KEY'], KEY);
    assert.match(r.headers['User-Agent'], /^gladys-aeso\//);
    assert.equal(r.url.includes(KEY), false);
  }
  // 34 whole days and 11 hours of today, two slots each.
  assert.equal(entries().length, (34 * 24 + 11) * 2);
  const t = dayStart('2026-11-14') + 3 * HOUR;
  const slots = entries().filter((e) => [t, t + 30 * MINUTE].includes(Date.parse(e.starts_at)));
  assert.equal(slots.length, 2);
  for (const slot of slots) assert.equal(slot.value, perKwh(priceAt(t)));
  for (const e of entries()) assert.equal(Date.parse(e.starts_at) % (30 * MINUTE), 0);
  assert.equal(status().connected, true);
  assert.match(status().message.en, /through the hour ending 2026-11-14 11:00/);
  assert.match(status().message.en, /1 energy contract/);
  assert.equal(app.days.size, 35);
});

test('every hour, 5 minutes after its end: today only, never sooner', async () => {
  const { source, wait, entries } = await setup();
  const before = entries().length;
  // 11:20 -> 12:04: nothing; 12:05: today's hours.
  await wait(44 * MINUTE);
  assert.equal(source.count(), 2);
  await wait(1 * MINUTE + SECOND);
  assert.equal(source.count(), 3);
  const r = source.requests[2];
  assert.equal(r.first, '2026-11-14');
  assert.equal(r.hasEnd, false, 'one day: no endDate (it must follow startDate)');
  assert.equal(entries().length, before + 2);
  // A whole day later: one request an hour, 24 of them.
  await wait(DAY);
  assert.equal(source.count(), 3 + 24);
});

test('an hour late at the AESO: asked again 10 minutes later, not sooner, then back to hourly', async () => {
  const { source, wait, clock } = await setup();
  // The AESO settles the hours 20 minutes after their end now.
  source.handler = (r) => answer(r.first, r.last, clock.now(), { lag: 20 * MINUTE });
  await wait(45 * MINUTE + SECOND); // 12:05
  assert.equal(source.count(), 3);
  await wait(9 * MINUTE);
  assert.equal(source.count(), 3);
  await wait(MINUTE + SECOND); // 12:15: still missing
  assert.equal(source.count(), 4);
  await wait(10 * MINUTE); // 12:25: settled
  assert.equal(source.count(), 5);
  await wait(30 * MINUTE); // 12:55: nothing more until 13:05
  assert.equal(source.count(), 5);
});

test('midnight: the last hour of yesterday asked at 00:05, alone', async () => {
  const { source, wait } = await setup({ now: Date.parse('2026-11-15T05:50:00Z') }); // 23:50
  const n = source.count();
  await wait(15 * MINUTE); // 00:05
  assert.equal(source.count(), n + 1);
  assert.equal(source.requests[n].first, '2026-11-14');
  assert.equal(source.requests[n].hasEnd, false);
});

test('without a key, or a malformed one, nothing is asked; a key saved is tried at once', async () => {
  const { source, status, wait, gladys } = await setup({ config: {} });
  await wait(3 * HOUR);
  assert.equal(source.count(), 0);
  assert.match(status().message.en, /Enter your AESO API key/);
  await gladys.fake.configUpdated({ api_key: 'has space in it' });
  await wait(HOUR);
  assert.equal(source.count(), 0);
  assert.match(status().message.en, /does not look like/);
  await gladys.fake.configUpdated({ api_key: KEY });
  await wait(0);
  assert.equal(source.count(), 2);
  assert.equal(status().connected, true);
});

test('a refused key (401): no automatic request, kept across a restart, lifted by a new key or the button', async () => {
  const store = createMemoryStore();
  const { source, status, wait, gladys, app, lines } = await setup({
    store,
    handler: () =>
      json({ statusCode: 401, message: 'Access denied due to invalid subscription key.' }, 401),
  });
  assert.equal(source.count(), 1, 'stopped at the first 401');
  await wait(2 * DAY);
  assert.equal(source.count(), 1);
  assert.match(status().message.en, /refused this API key/);
  assert.equal(status().connected, false);
  assert.ok(store.data.refused && Number.isInteger(store.data.refused.tag));
  assert.equal(JSON.stringify(store.data).includes(KEY), false);
  assert.equal(lines.join('\n').includes(KEY), false);
  await app.stop();

  // A restart with the same key: still nothing.
  const again = await setup({ store, handler: () => json({}, 401) });
  await again.wait(DAY);
  assert.equal(again.source.count(), 0);
  assert.match(again.status().message.en, /refused this API key/);

  // The button tries once (a click), and its success lifts the refusal.
  again.source.handler = undefined;
  const ack = await again.gladys.fake.action('test_key', {});
  assert.match(ack.data.message.en, /Key accepted/);
  assert.equal(again.source.count(), 1, 'one request: the most recent days');
  assert.equal(again.store.data.refused, undefined);
  await again.wait(2 * MINUTE);
  assert.ok(again.source.count() >= 2, 'the schedule resumes');
  await again.app.stop();

  // A new key is always tried, even when the old one was refused.
  void gladys;
  const third = await setup({ handler: () => json({}, 401) });
  assert.equal(third.source.count(), 1);
  third.source.handler = undefined;
  await third.gladys.fake.configUpdated({ api_key: 'another-key-0123456789' });
  await third.wait(MINUTE + SECOND);
  assert.equal(third.source.count(), 3);
  assert.equal(third.source.requests[1].headers['API-KEY'], 'another-key-0123456789');
  assert.equal(third.store.data.refused, undefined);
});

test('a 401 for a key changed meanwhile never marks the new key refused', async () => {
  let release;
  const { source, gladys, clock, app, wait } = await setup({
    start: false,
    handler: () =>
      new Promise((resolve) => {
        release = () => resolve(json({}, 401));
      }),
  });
  await gladys.connect();
  await clock.advance(0);
  assert.equal(source.count(), 1);
  await gladys.fake.configUpdated({ api_key: 'the-new-key-0123456789' });
  source.handler = undefined;
  release();
  await clock.advance(0);
  await app.idle();
  assert.equal(app.refused, undefined, 'the new key is not marked refused');
  assert.doesNotMatch(gladys.fake.connectionStatus.message.en, /refused/);
  await wait(MINUTE + SECOND);
  assert.equal(app.refused, undefined);
  assert.ok(source.count() >= 2);
  assert.equal(source.requests.at(-1).headers['API-KEY'], 'the-new-key-0123456789');
});

test('a 403 is not a refused key: back-off, the next hours still asked', async () => {
  const { source, wait, status, store } = await setup({
    handler: () => new Response('', { status: 403 }),
  });
  assert.equal(source.count(), 1);
  assert.match(status().message.en, /answered 403/);
  assert.equal(store.data.refused, undefined);
  await wait(5 * MINUTE + SECOND);
  assert.equal(source.count(), 2);
  await wait(15 * MINUTE + SECOND);
  assert.equal(source.count(), 3);
});

test('a 429 pauses (Retry-After, bounded, kept in /data across a restart); the quota 403 too', async () => {
  const store = createMemoryStore();
  const first = await setup({
    store,
    handler: () => new Response('', { status: 429, headers: { 'retry-after': '1800' } }),
  });
  assert.equal(first.source.count(), 1);
  first.source.handler = undefined;
  await first.wait(29 * MINUTE);
  assert.equal(first.source.count(), 1);
  const ack = await first.gladys.fake.action('test_key', {});
  assert.match(ack.data.message.en, /slow down/);
  assert.equal(first.source.count(), 1, 'the button waits for the pause too');
  await first.app.stop();
  // Restarted 29 minutes in: the pause keeps its rest.
  const second = await setup({ store, now: NOW + 29 * MINUTE });
  assert.equal(second.source.count(), 0);
  await second.wait(MINUTE + SECOND);
  assert.equal(second.source.count(), 2);
  await second.app.stop();

  const capped = await setup({
    handler: () => new Response('', { status: 429, headers: { 'retry-after': '999999' } }),
  });
  capped.source.handler = undefined;
  await capped.wait(PAUSE_MAX - MINUTE);
  assert.equal(capped.source.count(), 1);
  await capped.wait(2 * MINUTE);
  assert.equal(capped.source.count(), 3);
  await capped.app.stop();

  const quota = await setup({
    handler: () =>
      new Response(
        '{"message":"Out of call volume quota. Quota will be replenished in 00:20:00."}',
        {
          status: 403,
        },
      ),
  });
  quota.source.handler = undefined;
  await quota.wait(19 * MINUTE);
  assert.equal(quota.source.count(), 1);
  await quota.wait(2 * MINUTE);
  assert.equal(quota.source.count(), 3);
  assert.equal(quota.store.data.refused, undefined);
});

test('5xx, timeouts, too large or unreadable answers: growing back-off, never a storm', async () => {
  for (const out of [
    new Response('', { status: 503 }),
    'timeout',
    new Response('x'.repeat(2 * 1024 * 1024)),
    { nothing: true },
  ]) {
    const { source, wait, status, app } = await setup({ handler: () => out });
    assert.equal(source.count(), 1);
    assert.equal(status().connected, false);
    await wait(4 * MINUTE);
    assert.equal(source.count(), 1);
    await wait(MINUTE + SECOND);
    assert.equal(source.count(), 2);
    await wait(14 * MINUTE);
    assert.equal(source.count(), 2);
    await wait(MINUTE + SECOND);
    assert.equal(source.count(), 3);
    await wait(DAY);
    assert.ok(source.count() < 3 + 12, `${source.count()} requests in a day of failures`);
    await app.stop();
  }
});

test('the API retired (404): asked again every 6 hours', async () => {
  const { source, wait, status } = await setup({
    handler: () => new Response('', { status: 404 }),
  });
  assert.match(status().message.en, /retired/);
  await wait(6 * HOUR - MINUTE);
  assert.equal(source.count(), 1);
  await wait(2 * MINUTE);
  assert.equal(source.count(), 2);
});

test('a restart or a reconnection never asks sooner than a minute after the last request', async () => {
  const store = createMemoryStore();
  const first = await setup({ store });
  await first.wait(45 * MINUTE + SECOND); // 12:05:01: the hourly request
  assert.equal(first.source.count(), 3);
  await first.app.stop();
  assert.ok(store.data.attemptAt);
  // The hours of today are held: nothing is due before 13:05.
  const second = await setup({ store, now: NOW + 45 * MINUTE + 20 * SECOND });
  await second.wait(30 * MINUTE);
  assert.equal(second.source.count(), 0);
  // A reconnection: nothing more.
  await second.gladys.disconnect();
  await second.gladys.connect();
  await second.wait(SECOND);
  assert.equal(second.source.count(), 0);

  // Data lost (every day missing) but an attempt 20 s ago: the request waits for the minute.
  const third = await setup({
    store: createMemoryStore({ attemptAt: NOW - 20 * SECOND }),
  });
  assert.equal(third.source.count(), 0);
  await third.wait(39 * SECOND);
  assert.equal(third.source.count(), 0);
  await third.wait(2 * SECOND);
  assert.equal(third.source.count(), 2);
});

test('getConfig() failing in connected: retried, spaced, with a status, then the reads start', async (t) => {
  const { gladys, source, wait, status, app } = await setup({ start: false });
  let fail = 2;
  const real = gladys.getConfig.bind(gladys);
  t.mock.method(gladys, 'getConfig', async () => {
    if (fail > 0) {
      fail -= 1;
      throw new GladysApiError(503, 'UNAVAILABLE', 'down');
    }
    return real();
  });
  await app.connected();
  await wait(0);
  assert.equal(source.count(), 0);
  assert.match(status().message.en, /configuration could not be read/);
  await wait(10 * SECOND + 1);
  // The second failure: 20 s later.
  assert.equal(source.count(), 0);
  await wait(20 * SECOND + 1);
  assert.equal(source.count(), 2);
  assert.equal(status().connected, true);

  // A reconnection whose getConfig() fails once: said, retried, the schedule goes on.
  fail = 1;
  await app.connected();
  await wait(0);
  assert.match(status().message.en, /configuration could not be read/);
  assert.equal(status().connected, false);
  await wait(10 * SECOND + 1);
  assert.equal(status().connected, true);
  await wait(45 * MINUTE);
  assert.equal(source.count(), 3, 'the hourly request after the reconnection');
});

test('/data unreadable: nothing asked, read again every 10 seconds; /data not writable: said, data kept', async () => {
  const store = createMemoryStore({ attemptAt: NOW - HOUR });
  store.unreadable = true;
  const { source, wait, status } = await setup({ store });
  await wait(HOUR);
  assert.equal(source.count(), 0);
  assert.match(status().message.en, /cannot be read/);
  store.unreadable = false;
  await wait(10 * SECOND + 1);
  assert.equal(source.count(), 2);

  const broken = createMemoryStore();
  broken.failSave = true;
  const other = await setup({ store: broken });
  assert.equal(other.source.count(), 2);
  assert.match(other.status().message.en, /cannot be written/);
  assert.ok(other.entries().length > 0);
});

test('the calendar owned by another integration (403) or failing: said, the reads go on, retried', async (t) => {
  const { gladys, source, wait, status, app } = await setup({ start: false });
  let mode = 'refused';
  const real = gladys.publishEnergyCalendar.bind(gladys);
  t.mock.method(gladys, 'publishEnergyCalendar', async (...args) => {
    if (mode === 'refused') throw new GladysApiError(403, 'FORBIDDEN', 'owned');
    if (mode === 'error') throw new GladysApiError(500, 'ERROR', 'boom');
    return real(...args);
  });
  await gladys.connect();
  await wait(0);
  assert.equal(source.count(), 2);
  assert.match(status().message.en, /fed by another integration/);
  mode = 'error';
  await wait(45 * MINUTE + SECOND);
  assert.equal(source.count(), 3);
  assert.match(status().message.en, /could not be fed/);
  mode = 'ok';
  await wait(HOUR);
  assert.equal(source.count(), 4);
  assert.equal(gladys.fake.energyCalendars[CALENDAR].length, (34 * 24 + 13) * 2);
  assert.doesNotMatch(status().message.en, /calendar/);
  void app;
});

test('a corrected price replaces the held one; a price absent from a later answer is kept', async () => {
  const { source, wait, entries, clock, app } = await setup();
  const t = dayStart('2026-11-14') + 2 * HOUR;
  source.handler = (r) => {
    const body = answer(r.first, r.last, clock.now());
    const rows = body.return['Pool Price Report'];
    const k = rows.findIndex((x) => x.begin_datetime_utc === row(t, '').begin_datetime_utc);
    rows[k] = row(t, '123.45');
    rows.splice(0, 1); // the first hour missing
    return body;
  };
  await wait(45 * MINUTE + SECOND);
  const slot = entries().find((e) => Date.parse(e.starts_at) === t);
  assert.equal(slot.value, 0.12345);
  const midnight = entries().find((e) => Date.parse(e.starts_at) === dayStart('2026-11-14'));
  assert.equal(midnight.value, perKwh(priceAt(dayStart('2026-11-14'))));
  assert.equal(app.days.get('2026-11-14').prices[0], priceAt(dayStart('2026-11-14')), 'kept');
});

test('a contract starting earlier: its days read too, three ranges a check, a minute apart', async () => {
  const { source, wait, app } = await setup({
    contracts: [{ ...CONTRACT, valid_from: '2026-06-01' }],
  });
  // The first check holds the 35 days (the contracts are read after it).
  assert.equal(source.count(), 2);
  await wait(MINUTE - SECOND);
  assert.equal(source.count(), 2);
  // 2026-06-01 .. 2026-10-10 lacking: 132 days, five ranges, three then two.
  await wait(2 * SECOND);
  assert.equal(source.count(), 5);
  await wait(MINUTE);
  assert.equal(source.count(), 7);
  assert.equal(source.requests.map((r) => r.first).sort()[0], '2026-06-01');
  assert.ok(app.days.has('2026-06-01'));
  await wait(10 * MINUTE);
  assert.equal(source.count(), 7);
});

test('the contracts not readable: the reads go on, the status says nothing of them', async (t) => {
  const { gladys, source, wait, status } = await setup({ start: false });
  t.mock.method(gladys, 'getEnergyContracts', async () => {
    throw new GladysApiError(500, 'ERROR', 'boom');
  });
  await gladys.connect();
  await wait(0);
  assert.equal(source.count(), 2);
  assert.equal(status().connected, true);
  assert.doesNotMatch(status().message.en, /contract/);
});

test('no contract on the template: said in the status', async () => {
  const { status } = await setup({ contracts: [] });
  assert.match(status().message.en, /No energy contract uses/);
});

test('the button: too soon, busy, then the answer of one request', async () => {
  const { gladys, source, wait } = await setup();
  let ack = await gladys.fake.action('test_key', {});
  assert.match(ack.data.message.en, /less than a minute ago: try again in \d+ s/);
  assert.equal(source.count(), 2);
  await wait(MINUTE + SECOND);
  ack = await gladys.fake.action('test_key', {});
  assert.match(
    ack.data.message.en,
    /Key accepted by the AESO: \d+ settled hour\(s\) read, the last one ending 2026-11-14 11:00/,
  );
  assert.equal(source.count(), 3);
  await wait(MINUTE + SECOND);
  source.handler = () => new Response('', { status: 401 });
  ack = await gladys.fake.action('test_key', {});
  assert.match(ack.data.message.en, /refused the key \(401\)/);
});

test('the button with no key: says so, asks nothing', async () => {
  const { gladys, source } = await setup({ config: { api_key: '' } });
  const ack = await gladys.fake.action('test_key', {});
  assert.match(ack.data.message.en, /Enter your AESO API key/);
  assert.equal(source.count(), 0);
});

test('a tz database without the 2026 change: nothing asked, said', async () => {
  const { gladys } = await setup({ start: false });
  const { createSource } = await import('./helpers/app.js');
  const { testClock } = await import('./helpers/clock.js');
  const clock = testClock({ start: NOW });
  const source = createSource(clock);
  const app = new App({
    gladys,
    logger: { info() {}, warn() {}, error() {} },
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: createMemoryStore(),
    fetchImpl: source.fetch,
    tzCurrent: false,
  });
  await gladys.connect();
  await app.connected();
  await clock.advance(DAY);
  await app.idle();
  assert.equal(source.count(), 0);
  assert.match(gladys.fake.connectionStatus.message.en, /time zone database/);
  assert.match((await app.testKey()).en, /time zone database/);
  await app.stop();
});

test('the key never leaves in a log, a status, /data or the calendar', async () => {
  const { lines, gladys, store, entries, wait } = await setup({
    handler: () => new Response('', { status: 401 }),
  });
  await gladys.fake.configUpdated({ api_key: `${KEY}x` });
  await wait(MINUTE + SECOND);
  await gladys.fake.action('test_key', {});
  const everything = [
    lines.join('\n'),
    JSON.stringify(gladys.fake.connectionStatuses),
    JSON.stringify(store.data),
    JSON.stringify(entries()),
  ].join('\n');
  assert.equal(everything.includes(KEY), false);
});

test('stop: no timer, no request after it; the state saved', async () => {
  const { app, clock, source, store } = await setup();
  const saves = store.saves;
  await app.stop();
  assert.equal(clock.pending, 0, 'every timer cleared at stop');
  assert.ok(store.saves > saves);
  const n = source.count();
  await clock.advance(3 * DAY);
  assert.equal(source.count(), n);
  assert.equal(clock.pending, 0);
});

test('/data: days kept a year and a month, a stored day that does not read is asked again', async () => {
  const old = '2025-09-01';
  const store = createMemoryStore({
    days: {
      [old]: Array(24).fill(10),
      '2026-11-13': Array(24).fill('x'),
      '2026-11-12': Array(24).fill(42),
    },
    sent: { '2026-11-12': 'zz' },
    pause: { until: NOW + 100 * DAY },
    failures: -3,
  });
  const { app, source, lines } = await setup({ store });
  assert.equal(app.days.has(old), false);
  assert.equal(app.days.get('2026-11-12').prices[0], 42);
  assert.ok(lines.some((l) => /2026-11-13 unusable/.test(l)));
  // The pause read back is capped to 6 hours: the first request waits for it.
  assert.equal(source.count(), 0);
  assert.ok(app.pause.until <= NOW + PAUSE_MAX + SECOND);
});

test('status words: never connected while the last attempt failed', async () => {
  const { status, source, wait } = await setup();
  assert.equal(status().connected, true);
  source.handler = () => new Response('', { status: 500 });
  await wait(45 * MINUTE + SECOND);
  assert.equal(status().connected, false);
  assert.match(text(status()), /5xx/);
});

test('a past day the AESO answers incomplete: asked again once a day, not every 10 minutes', async () => {
  const hole = dayStart('2026-11-01') + 5 * HOUR;
  const { source, wait } = await setup({
    handler: (r) => {
      const body = answer(r.first, r.last, r.at);
      body.return['Pool Price Report'] = body.return['Pool Price Report'].filter(
        (x) => x.begin_datetime_utc !== row(hole, '').begin_datetime_utc,
      );
      return body;
    },
  });
  const old = () =>
    source.requests.filter((r) => r.first <= '2026-11-01' && r.last >= '2026-11-01').length;
  assert.equal(old(), 1);
  await wait(6 * HOUR);
  assert.equal(old(), 1);
  await wait(18 * HOUR + MINUTE);
  assert.equal(old(), 2);
});

test('hours that do not read (a shifted MPT time): an unreadable answer, not connected, backing off', async () => {
  const { source, wait, status, entries } = await setup({
    handler: (r) => {
      const body = answer(r.first, r.last, r.at);
      for (const x of body.return['Pool Price Report']) {
        x.begin_datetime_mpt = x.begin_datetime_mpt.replace(
          / (\d\d):/,
          (m, h) => ` ${String((Number(h) + 1) % 24).padStart(2, '0')}:`,
        );
      }
      return body;
    },
  });
  assert.equal(entries().length, 0);
  assert.equal(status().connected, false);
  assert.match(status().message.en, /unreadable answer/);
  assert.match(status().message.en, /provisional price/);
  await wait(3 * HOUR);
  assert.ok(source.count() <= 6, `${source.count()} requests in 3 hours`);
});

test('a future attempt time in /data is not believed: the start asks at once', async () => {
  const { source } = await setup({ store: createMemoryStore({ attemptAt: NOW + 2 * HOUR }) });
  assert.equal(source.count(), 2);
});

test('a contract older than 400 days: the reads stop at 400 days, no endless rereading', async () => {
  const { source, wait, app } = await setup({
    contracts: [{ ...CONTRACT, valid_from: '2024-01-01' }],
  });
  await wait(10 * MINUTE);
  const n = source.count();
  assert.ok(n >= 14 && n <= 16, `${n} requests`);
  await wait(30 * MINUTE); // 12:00: before the hourly request
  assert.equal(source.count(), n, 'nothing read again');
  assert.equal([...app.days.keys()].sort()[0], '2025-10-11');
});

test('a contract months back: every day reaches the calendar, in batches of 2,000 at most', async (t) => {
  const { gladys, wait, entries } = await setup({
    start: false,
    contracts: [{ ...CONTRACT, valid_from: '2026-06-01' }],
  });
  const sizes = [];
  const real = gladys.publishEnergyCalendar.bind(gladys);
  t.mock.method(gladys, 'publishEnergyCalendar', async (key, list) => {
    sizes.push(list.length);
    return real(key, list);
  });
  await gladys.connect();
  await wait(3 * MINUTE);
  // 2026-06-01 .. 2026-11-13 (166 days) and 11 hours of today, two slots an hour.
  assert.equal(entries().length, (166 * 24 + 11) * 2);
  assert.ok(
    sizes.every((n) => n <= 2000),
    sizes.join(','),
  );
});

test('a calendar lost by Gladys (a database restored) is sent again at the next connection', async () => {
  const { gladys, wait, entries, source } = await setup();
  const full = entries().length;
  gladys.fake.energyCalendars[CALENDAR].splice(0);
  await gladys.disconnect();
  await gladys.connect();
  await wait(SECOND);
  assert.equal(entries().length, full);
  assert.equal(source.count(), 2, 'no request to the AESO for that');
});

test('a pause shorter than a minute is taken as a minute', async () => {
  const { store } = await setup({
    handler: () => new Response('', { status: 429, headers: { 'retry-after': '1' } }),
  });
  assert.ok(store.data.pause.until >= NOW + 60 * SECOND);
});

test('after a restart, a new key clears the refusal kept in /data', async () => {
  const store = createMemoryStore();
  const first = await setup({ store, handler: () => json({}, 401) });
  assert.ok(store.data.refused);
  await first.app.stop();
  const second = await setup({ store });
  assert.equal(second.source.count(), 0);
  await second.gladys.fake.configUpdated({ api_key: 'another-key-0123456789' });
  assert.equal(second.source.count(), 0, 'not yet: a minute after the last request');
  assert.equal(store.data.refused, undefined, 'cleared at once, not by a later success');
  await second.wait(MINUTE + SECOND);
  assert.equal(store.data.refused, undefined);
  assert.equal(second.source.count(), 2);
});

/** Counts the calendar publications from now on. */
function spyPublish(t, gladys) {
  const calls = [];
  const real = gladys.publishEnergyCalendar.bind(gladys);
  t.mock.method(gladys, 'publishEnergyCalendar', async (key, list) => {
    calls.push(list);
    return real(key, list);
  });
  return calls;
}

test('reconnection: nothing lost, nothing sent again (today partial included)', async (t) => {
  const { gladys, wait } = await setup();
  const calls = spyPublish(t, gladys);
  await gladys.disconnect();
  await gladys.connect();
  await wait(SECOND);
  assert.equal(calls.length, 0);
});

test('the nightly purge of the core (the oldest days) is never sent again', async (t) => {
  const { gladys, wait, entries } = await setup();
  const cut = new Date(dayStart('2026-11-04')).toISOString();
  const list = gladys.fake.energyCalendars[CALENDAR];
  list.splice(
    0,
    list.findIndex((e) => e.starts_at >= cut),
  );
  const kept = entries().length;
  const calls = spyPublish(t, gladys);
  for (let i = 0; i < 3; i += 1) {
    await gladys.disconnect();
    await gladys.connect();
    await wait(SECOND);
  }
  assert.equal(calls.length, 0);
  assert.equal(entries().length, kept);
});

test('a restored database (the end of the calendar lost): those days sent again, only those', async (t) => {
  const { gladys, wait, entries } = await setup();
  const full = entries().length;
  const cut = new Date(dayStart('2026-11-13')).toISOString();
  const list = gladys.fake.energyCalendars[CALENDAR];
  list.splice(list.findIndex((e) => e.starts_at >= cut));
  const calls = spyPublish(t, gladys);
  await gladys.disconnect();
  await gladys.connect();
  await wait(SECOND);
  assert.equal(entries().length, full);
  assert.equal(calls.flat().length, (24 + 11) * 2);
});

test('a second half-hour lost alone is sent again', async () => {
  const { gladys, wait, entries } = await setup();
  const full = entries().length;
  const lost = new Date(dayStart('2026-11-14') + 3 * HOUR + 30 * MINUTE).toISOString();
  const list = gladys.fake.energyCalendars[CALENDAR];
  list.splice(
    list.findIndex((e) => e.starts_at === lost),
    1,
  );
  await gladys.disconnect();
  await gladys.connect();
  await wait(SECOND);
  assert.equal(entries().length, full);
});

test('the read-back hanging or failing never blocks the connection nor the reads', async (t) => {
  for (const mode of ['hang', '403', 'throw']) {
    const { gladys, app, clock, source, wait, status, entries } = await setup();
    t.mock.method(gladys, 'getEnergyCalendar', async () => {
      if (mode === 'hang') return new Promise(() => {});
      if (mode === '403') throw new GladysApiError(403, 'FORBIDDEN', 'not yours');
      throw new Error('boom');
    });
    gladys.fake.energyCalendars[CALENDAR].splice(0);
    let result = 'hung';
    app.connected().then(() => {
      result = 'done';
    });
    // 30 s of virtual time, in steps: the read-back gives up at 20 s.
    for (let i = 0; i < 6 && result !== 'done'; i += 1) {
      await clock.advance(5 * SECOND);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(result, 'done', mode);
    await wait(45 * MINUTE);
    assert.equal(source.count(), 3, `${mode}: the hourly read goes on`);
    assert.equal(status().connected, true);
    assert.ok(entries().length > 0, `${mode}: the new hour is published`);
    await app.stop();
  }
});

test('the read-back of an old connection changes nothing once stopped', async (t) => {
  const { gladys, app, clock } = await setup();
  let release;
  const real = gladys.getEnergyCalendar.bind(gladys);
  t.mock.method(gladys, 'getEnergyCalendar', (key, options) =>
    options?.limit
      ? real(key, options)
      : new Promise((resolve) => {
          release = resolve;
        }),
  );
  const sent = { ...app.sent };
  const pending = app.connected();
  for (let i = 0; i < 20 && !release; i += 1) await clock.advance(0);
  assert.ok(release, 'the second read is under way');
  await app.stop();
  release([]);
  await pending;
  assert.deepEqual(app.sent, sent);
});

test('a broken row for an hour already held: no failure, still connected', async () => {
  const { source, wait, status, app } = await setup();
  const held = dayStart('2026-11-14') + 2 * HOUR;
  source.handler = (r) => {
    const body = answer(r.first, r.last, r.at);
    body.return['Pool Price Report'].push({ ...row(held, '12.00'), begin_datetime_mpt: 'garbage' });
    return body;
  };
  await wait(45 * MINUTE + SECOND);
  assert.equal(source.count(), 3);
  assert.equal(app.meta.failures, 0);
  assert.equal(status().connected, true);
});

test('one settled hour unreadable for good: the hourly rhythm goes on, said, asked again a day later', async () => {
  const bad = dayStart('2026-11-14') + 11 * HOUR; // 11:00-12:00, settled at 12:01
  const { source, wait, status, app } = await setup();
  source.handler = (r) => {
    const body = answer(r.first, r.last, r.at);
    for (const x of body.return['Pool Price Report']) {
      if (x.begin_datetime_utc === row(bad, '').begin_datetime_utc && x.pool_price) {
        x.pool_price = 'N/A';
      }
    }
    return body;
  };
  await wait(45 * MINUTE + SECOND); // 12:05: the hour reads as N/A only after 13:00
  await wait(HOUR); // 13:05: 'N/A' an hour after its end: unreadable
  const n = source.count();
  assert.match(status().message.en, /1 settled hour\(s\) unreadable/);
  assert.equal(status().connected, true);
  await wait(5 * HOUR);
  assert.ok(source.count() - n <= 6, `${source.count() - n} requests in 5 hours`);
  assert.equal(app.meta.failures, 0);
  // The next day, once its day of waiting is over: asked again.
  const before = source.count();
  await wait(19 * HOUR); // 13:05 the next day
  const covering = () =>
    source.requests.slice(before).filter((r) => r.first <= '2026-11-14' && r.last >= '2026-11-14')
      .length;
  const early = covering();
  await wait(30 * MINUTE);
  assert.ok(covering() > early, 'the unreadable hour asked again after a day');
});

test('an answer with nothing readable while every hour is held is no failure', async () => {
  const { gladys, source, wait, app } = await setup();
  await wait(MINUTE + SECOND); // 11:21: every hour up to 10:00 held
  source.handler = (r) => ({
    'Pool Price Report': [{ ...row(dayStart(r.first) + HOUR, '1.00'), begin_datetime_mpt: 'x' }],
  });
  const ack = await gladys.fake.action('test_key', {});
  assert.match(ack.data.message.en, /Key accepted/);
  assert.equal(app.meta.failures, 0);
});
