// -----------------------------------------------------------------------------
// Reading the AESO answers (never trusted) and the Mountain time helpers:
// the clock changes, the strict numbers, the bounds, the envelopes.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, tagOf, validRefused } from '../src/config.js';
import {
  DataError,
  dayRecord,
  parseAnswer,
  perKwh,
  priceOf,
  restoreDay,
  sameDay,
  utcHour,
} from '../src/data.js';
import { TZ_CURRENT, addDays, dayOf, dayStart, hoursOf, localText } from '../src/time.js';
import { answer, priceAt, row } from './fixtures/aeso.js';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-14T17:20:00Z');

test('Mountain time: midnight, the last clock changes (23 and 25 hours), permanent UTC-6 since 2026-11-01', () => {
  assert.equal(dayStart('2026-01-15'), Date.parse('2026-01-15T07:00:00Z'), 'MST, UTC-7');
  assert.equal(dayStart('2026-07-01'), Date.parse('2026-07-01T06:00:00Z'), 'MDT, UTC-6');
  // Alberta keeps UTC-6 all year from 1 November 2026 (tz database 2026c).
  assert.equal(dayStart('2026-11-14'), Date.parse('2026-11-14T06:00:00Z'), 'UTC-6 in winter now');
  assert.equal(dayStart('2027-01-15'), Date.parse('2027-01-15T06:00:00Z'));
  // The last changes: second Sunday of March 2026, first Sunday of November 2025.
  assert.equal(hoursOf('2026-03-08'), 23);
  assert.equal(hoursOf('2025-11-02'), 25);
  assert.equal(hoursOf('2026-11-01'), 24, 'no change any more');
  assert.equal(hoursOf('2027-03-14'), 24);
  assert.equal(hoursOf('2027-11-07'), 24);
  // Just before and after local midnight, in winter and in summer.
  assert.equal(dayOf(Date.parse('2026-11-15T05:59:59Z')), '2026-11-14');
  assert.equal(dayOf(Date.parse('2026-11-15T06:00:00Z')), '2026-11-15');
  assert.equal(dayOf(Date.parse('2026-01-16T06:59:59Z')), '2026-01-15');
  assert.equal(dayOf(Date.parse('2026-01-16T07:00:00Z')), '2026-01-16');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(localText(Date.parse('2025-11-02T08:00:00Z')), '2025-11-02 01:00');
  assert.equal(localText(Date.parse('2025-11-02T07:00:00Z')), '2025-11-02 01:00', 'twice that day');
  assert.equal(TZ_CURRENT, true, 'the tz database of this Node knows the 2026 change');
});

test('a day of the fixture reads whole, the hours not settled stay unknown', () => {
  const { hours, refused } = parseAnswer(answer('2026-11-14', '2026-11-14', NOW), NOW);
  assert.equal(refused, 0);
  const record = dayRecord('2026-11-14', hours);
  // 11:20 local: the hours 00:00 to 10:00 settled (11 hours), 11:00 not yet.
  assert.equal(record.known, 11);
  assert.equal(record.prices[0], priceAt(dayStart('2026-11-14')));
  assert.equal(record.prices[11], null);
  assert.equal(record.prices.length, 24);
});

test('both envelopes read; a responseCode other than 200, a missing report or too many rows are refused', () => {
  const later = NOW + 3 * HOUR;
  const bare = parseAnswer(answer('2026-11-14', '2026-11-14', later, { envelope: false }), later);
  assert.ok(bare.hours.size > 0);
  const rows = answer('2026-11-14', '2026-11-14', later).return['Pool Price Report'];
  for (const bad of [
    null,
    [],
    'text',
    {},
    { return: {} },
    { return: null },
    { responseCode: '500', return: { 'Pool Price Report': rows } },
    { 'Pool Price Report': {} },
    { 'Pool Price Report': Array.from({ length: 1001 }, () => rows[0]) },
  ]) {
    assert.throws(() => parseAnswer(bad, later), DataError, JSON.stringify(bad)?.slice(0, 60));
  }
});

test('the dual DST hour: both 01:00 MPT read, by their UTC start', () => {
  const day = '2025-11-02';
  const now = Date.parse('2026-11-02T12:00:00Z');
  const { hours, refused } = parseAnswer(answer(day, day, now), now);
  assert.equal(refused, 0);
  const record = dayRecord(day, hours);
  assert.equal(record.known, 25);
  assert.notEqual(record.prices[1], record.prices[2], 'two different hours');
  const spring = parseAnswer(answer('2026-03-08', '2026-03-08', now), now);
  assert.equal(dayRecord('2026-03-08', spring.hours).known, 23);
});

test('a row is refused when its two starts disagree, its start is not on the hour, or its price is no plain number', () => {
  const t = Date.parse('2026-11-14T08:00:00Z');
  const ok = row(t, '45.67');
  const cases = [
    { ...ok, begin_datetime_mpt: '2026-11-14 01:00' }, // the old UTC-7
    { ...ok, begin_datetime_utc: '2026-11-14 08:30', begin_datetime_mpt: '2026-11-14 01:30' },
    { ...ok, begin_datetime_utc: '2026-11-14T08:00' },
    { ...ok, begin_datetime_utc: '2026-02-30 08:00' },
    { ...ok, pool_price: '1e2' },
    { ...ok, pool_price: '45,67' },
    { ...ok, pool_price: 'N/A' },
    { ...ok, pool_price: 45.67 },
    { ...ok, pool_price: '3000.01' },
    { ...ok, pool_price: '-1000.01' },
    { ...ok, pool_price: '0x20' },
    'row',
  ];
  for (const bad of cases) {
    const { hours, refused } = parseAnswer({ 'Pool Price Report': [bad] }, NOW);
    assert.equal(hours.size, 0, JSON.stringify(bad));
    assert.equal(refused, 1, JSON.stringify(bad));
  }
  // Empty: not settled yet, never zero and not an error.
  for (const empty of ['', null, undefined]) {
    const { hours, refused } = parseAnswer(
      { 'Pool Price Report': [{ ...ok, pool_price: empty }] },
      NOW,
    );
    assert.equal(hours.size, 0);
    assert.equal(refused, 0);
  }
  const zero = parseAnswer({ 'Pool Price Report': [{ ...ok, pool_price: '0.00' }] }, NOW);
  assert.equal(zero.hours.get(t), 0, 'a real 0 (the floor) is a price');
  const edges = parseAnswer({ 'Pool Price Report': [{ ...ok, pool_price: ' 999.99 ' }] }, NOW);
  assert.equal(edges.hours.get(t), 999.99);
});

test('an hour not ended is never taken, even with a price; a duplicate with another price is dropped', () => {
  const current = Date.parse('2026-11-14T17:00:00Z'); // 11:00-12:00 local, under way
  const early = parseAnswer({ 'Pool Price Report': [row(current, '50.00')] }, NOW);
  assert.equal(early.hours.size, 0);
  const t = Date.parse('2026-11-14T08:00:00Z');
  const same = parseAnswer({ 'Pool Price Report': [row(t, '45.67'), row(t, '45.67')] }, NOW);
  assert.equal(same.hours.get(t), 45.67);
  const other = parseAnswer(
    { 'Pool Price Report': [row(t, '45.67'), row(t, '50.00'), row(t, '45.67')] },
    NOW,
  );
  assert.equal(other.hours.has(t), false);
  assert.equal(other.refused, 1);
});

test('helpers: utcHour, priceOf, perKwh, restoreDay, sameDay', () => {
  assert.equal(utcHour('2026-11-14 08:00'), Date.parse('2026-11-14T08:00:00Z'));
  assert.equal(utcHour('2026-11-14 24:00'), undefined);
  assert.equal(utcHour(42), undefined);
  assert.equal(priceOf('12'), 12);
  assert.equal(priceOf(''), undefined);
  assert.equal(perKwh(45.67), 0.04567);
  assert.equal(perKwh(999.99), 0.99999);
  assert.equal(perKwh(0.1), 0.0001);
  assert.equal(perKwh(-12.3), -0.0123);
  const prices = Array.from({ length: 24 }, (_, k) => (k < 3 ? 10 + k : null));
  const record = restoreDay('2026-11-14', prices);
  assert.equal(record.known, 3);
  assert.ok(sameDay(record, restoreDay('2026-11-14', [...prices])));
  assert.equal(sameDay(record, undefined), false);
  assert.equal(restoreDay('2026-11-14', prices.slice(1)), undefined, 'wrong length');
  assert.equal(restoreDay('2025-11-02', prices), undefined, 'the 25-hour day');
  for (const bad of ['10', NaN, Infinity, 3000.5, -1001, {}]) {
    const copy = [...prices];
    copy[5] = bad;
    assert.equal(restoreDay('2026-11-14', copy), undefined, String(bad));
  }
});

test('the configuration: a key, a missing one, a malformed one', () => {
  assert.deepEqual(normalizeConfig({ api_key: ' abcdef0123456789 ' }), {
    key: 'abcdef0123456789',
    problem: undefined,
  });
  for (const raw of [undefined, null, {}, { api_key: '' }, { api_key: '   ' }, { api_key: null }]) {
    assert.equal(normalizeConfig(raw).problem, 'missing', JSON.stringify(raw));
  }
  for (const value of [
    'short',
    'abc def0123456',
    'abcdef01234\r\n5678',
    'é'.repeat(20),
    42,
    'x'.repeat(129),
  ]) {
    const config = normalizeConfig({ api_key: value });
    assert.equal(config.problem, 'malformed', String(value));
    assert.equal(config.key, '', 'a malformed key is never kept');
  }
});

test('the tag of a refused key: 8 bits, salted; thousands of other keys share it', () => {
  const salt = '0123456789abcdef0123456789abcdef';
  const tag = tagOf(salt, 'the-refused-key-0001');
  assert.ok(Number.isInteger(tag) && tag >= 0 && tag < 256);
  const salted = new Set(
    Array.from({ length: 16 }, (_, i) =>
      tagOf(String(i).padStart(32, '0'), 'the-refused-key-0001'),
    ),
  );
  assert.ok(salted.size > 1, 'the salt changes the tag');
  // Brute force: among 20,000 candidate keys, about 78 match: the tag does not find the key.
  let matches = 0;
  for (let i = 0; i < 20_000; i += 1) if (tagOf(salt, `candidate-${i}`) === tag) matches += 1;
  assert.ok(matches > 30, `${matches} keys share the tag`);
  assert.deepEqual(validRefused({ salt, tag }), { salt, tag });
  for (const bad of [null, {}, { salt, tag: 256 }, { salt: 'xyz', tag: 1 }, { salt, tag: 1.5 }]) {
    assert.equal(validRefused(bad), undefined);
  }
});

test('a placeholder ("-") for an hour just ended is not settled yet; an hour later it is unreadable', () => {
  const t = Date.parse('2026-11-14T16:00:00Z'); // ends 17:00Z
  const soon = parseAnswer({ 'Pool Price Report': [row(t, '-')] }, t + HOUR + 5 * 60_000);
  assert.equal(soon.refused, 0);
  assert.equal(soon.bad.size, 0);
  const late = parseAnswer({ 'Pool Price Report': [row(t, '-')] }, t + 2 * HOUR);
  assert.equal(late.refused, 1);
  assert.deepEqual([...late.bad], [t]);
});
