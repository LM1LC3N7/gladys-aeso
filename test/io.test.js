// -----------------------------------------------------------------------------
// The network and /data helpers: Retry-After, the bounded read, the headers
// kept from an answer, the file store (missing vs unreadable, atomic writes).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceError, getJson, readBounded, retryAfterMs } from '../src/http.js';
import { createFileStore } from '../src/store.js';

test('Retry-After: seconds or an HTTP date', () => {
  const now = Date.parse('2026-01-15T12:00:00Z');
  assert.equal(retryAfterMs('120', now), 120_000);
  assert.equal(retryAfterMs('Thu, 15 Jan 2026 12:05:00 GMT', now), 300_000);
  assert.equal(retryAfterMs('Thu, 15 Jan 2026 11:00:00 GMT', now), 0);
  for (const bad of [undefined, null, '', 'soon', '-5']) {
    assert.equal(retryAfterMs(bad, now), undefined, String(bad));
  }
});

test('the bounded read: the declared length, the streamed size, a body without stream', async () => {
  assert.equal(await readBounded(new Response('abc'), 3), 'abc');
  await assert.rejects(readBounded(new Response('abcd'), 3), (e) => e.code === 'too_large');
  await assert.rejects(
    readBounded(new Response('x', { headers: { 'content-length': '99' } }), 3),
    (e) => e.code === 'too_large',
  );
  const plain = { headers: { get: () => null }, text: async () => 'abcd' };
  await assert.rejects(readBounded(plain, 3), (e) => e.code === 'too_large');
  assert.equal(
    await readBounded({ headers: { get: () => null }, text: async () => 'ab' }, 3),
    'ab',
  );
});

test('getJson: 200 with the key in its header, the retired version, a redirect never followed', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return new Response('{"prices":[]}');
  };
  const first = await getJson('https://x/y', { fetchImpl, limit: 100, key: 'k-123456789' });
  assert.deepEqual(first.json, { prices: [] });
  assert.equal(seen[0].init.redirect, 'error');
  assert.equal(seen[0].init.headers.Accept, 'application/json');
  assert.equal(seen[0].init.headers['API-KEY'], 'k-123456789');
  assert.match(
    seen[0].init.headers['User-Agent'],
    /^gladys-aeso\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/LM1LC3N7\/gladys-aeso\)$/,
  );
  assert.equal(String(seen[0].url).includes('k-123456789'), false, 'never in the URL');
  const fail410 = (status) =>
    getJson('https://x/y', { fetchImpl: async () => new Response('', { status }), limit: 100 });
  await assert.rejects(fail410(410), (e) => e.code === 'retired' && e.status === 410);
  await assert.rejects(fail410(404), (e) => e.code === 'retired');
  await assert.rejects(
    getJson('https://x/y', {
      fetchImpl: async () => new Response('x'.repeat(200)),
      limit: 100,
    }),
    (e) => e.code === 'too_large',
  );
  await assert.rejects(
    getJson('https://x/y', {
      fetchImpl: async () => {
        const err = new Error('t');
        err.name = 'TimeoutError';
        throw err;
      },
      limit: 100,
    }),
    (e) => e.code === 'timeout',
  );
  // A 429 with an HTTP date: measured on the server's Date header, not the local clock.
  await assert.rejects(
    getJson('https://x/y', {
      limit: 100,
      now: () => Date.parse('2026-01-15T13:00:00Z'),
      fetchImpl: async () =>
        new Response('', {
          status: 429,
          headers: {
            date: 'Thu, 15 Jan 2026 12:00:00 GMT',
            'retry-after': 'Thu, 15 Jan 2026 12:30:00 GMT',
          },
        }),
    }),
    (e) => e.code === 'rate_limited' && e.retryAfter === 30 * 60_000,
  );
  const fail = (response) =>
    getJson('https://x/y', { fetchImpl: async () => response, limit: 100 });
  await assert.rejects(fail(new Response('', { status: 500 })), (e) => e.code === 'server');
  await assert.rejects(fail(new Response('', { status: 400 })), (e) => e.code === 'http');
  // 401: the key; 403: a quota (a pause) or something else, never a refused key.
  await assert.rejects(
    fail(new Response('{"statusCode":401}', { status: 401 })),
    (e) => e.code === 'refused',
  );
  await assert.rejects(fail(new Response('', { status: 403 })), (e) => e.code === 'forbidden');
  await assert.rejects(
    fail(
      new Response(
        '{ "statusCode": 403, "message": "Out of call volume quota. Quota will be replenished in 01:02:03." }',
        { status: 403 },
      ),
    ),
    (e) => e.code === 'rate_limited' && e.retryAfter === (3600 + 120 + 3) * 1000,
  );
  await assert.rejects(
    fail(
      new Response('Out of call volume quota.', { status: 403, headers: { 'retry-after': '90' } }),
    ),
    (e) => e.code === 'rate_limited' && e.retryAfter === 90_000,
  );
  await assert.rejects(
    fail(new Response('quota'.repeat(2000), { status: 403 })),
    (e) => e.code === 'forbidden',
    'a 403 body too long to read is not a quota',
  );
  await assert.rejects(fail(new Response('{', { status: 200 })), (e) => e.code === 'invalid');
  await assert.rejects(
    getJson('https://x/y', {
      limit: 100,
      fetchImpl: async () => {
        throw new TypeError('fetch failed https://secret/url');
      },
    }),
    (e) => e instanceof SourceError && e.code === 'network' && !/secret/.test(e.message),
  );
});

test('the file store: missing, written atomically, read back, unreadable told apart', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'aeso-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');
  const store = createFileStore(file);
  assert.deepEqual(await store.load(), { status: 'missing' });
  await Promise.all([store.save({ a: 1 }), store.save({ a: 2 })]);
  assert.deepEqual(await store.load(), { status: 'ok', data: { a: 2 } });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { a: 2 });
  assert.equal((await stat(file)).mode & 0o777, 0o600, 'mode 0600');
  await writeFile(file, '{broken');
  assert.deepEqual(await store.load(), { status: 'unreadable' });
  await writeFile(file, '[1]');
  assert.deepEqual(await store.load(), { status: 'unreadable' });
  if (process.getuid?.() !== 0) {
    await writeFile(file, '{}');
    await chmod(file, 0o000);
    assert.deepEqual(await store.load(), { status: 'unreadable' });
    await chmod(file, 0o600);
  }
  const bad = createFileStore(join(dir, 'missing-dir', 'state.json'));
  await assert.rejects(bad.save({ a: 1 }));
  await bad.save({ a: 1 }).catch(() => {});
});
