// -----------------------------------------------------------------------------
// The only place that talks to the network: `fetch` with a timeout, the
// module's User-Agent, the API key in its header, and a body read up to a
// bound, never whole. Only the AESO Pool Price Report is ever asked; no
// redirect is followed (the key never leaves for another host). The key never
// appears in an error, a log or a URL. Taken from gladys-groupe-e-vario.
// -----------------------------------------------------------------------------

import { API_KEY_HEADER, HTTP_TIMEOUT, USER_AGENT } from './constants.js';

export class SourceError extends Error {
  /**
   * `code`: 'refused' (401: the key), 'forbidden' (403, not a quota),
   * 'rate_limited' (429, or the 403 of a quota), 'server', 'retired', 'http',
   * 'network', 'timeout', 'too_large', 'invalid'.
   */
  constructor(code, message, { status, retryAfter } = {}) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** Retry-After (seconds or an HTTP date) -> milliseconds, undefined when absent or invalid. */
export function retryAfterMs(value, now) {
  if (typeof value !== 'string' || value.length > 64) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value) * 1000;
  // An HTTP date names its day and month: a bare number or sign is not one.
  if (!/^[A-Za-z]{3}, /.test(value)) return undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** The body as text, refused past `limit` bytes (read in chunks, never whole). */
export async function readBounded(response, limit) {
  const tooLarge = () => new SourceError('too_large', `The answer is larger than ${limit} bytes`);
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel?.().catch(() => {});
    throw tooLarge();
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > limit) throw tooLarge();
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function networkError(err) {
  const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
  return timedOut
    ? new SourceError('timeout', 'The AESO API did not answer in time')
    : new SourceError('network', 'The AESO API is unreachable (network error)');
}

/** A short body (a 403) as text, bounded; '' when it does not read. */
async function shortText(response) {
  try {
    return await readBounded(response, 4096);
  } catch {
    return '';
  }
}

/**
 * GET the JSON answer of `url` with the key: resolves `{ json, date }` (the
 * server's Date header, epoch ms, when it reads), throws a SourceError
 * otherwise.
 */
export async function getJson(
  url,
  { key, limit, fetchImpl = globalThis.fetch, now = Date.now, timeout = HTTP_TIMEOUT } = {},
) {
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
    [API_KEY_HEADER]: key,
  };
  let response;
  try {
    response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(Math.max(1, timeout)),
      redirect: 'error',
    });
  } catch (err) {
    throw networkError(err);
  }
  const { status } = response;
  const served = Date.parse(response.headers?.get?.('date') ?? '');
  if (status === 200) {
    let body;
    try {
      body = await readBounded(response, limit);
    } catch (err) {
      throw err instanceof SourceError ? err : networkError(err);
    }
    try {
      return { json: JSON.parse(body), date: Number.isFinite(served) ? served : undefined };
    } catch {
      throw new SourceError('invalid', 'The AESO API answered something else than JSON');
    }
  }
  if (status === 401) {
    await response.body?.cancel?.().catch(() => {});
    throw new SourceError('refused', 'The AESO API refused the key (401)', { status });
  }
  if (status === 403) {
    // Azure API Management answers 403 "Out of call volume quota" when a quota
    // runs out: a pause, not a refused key. Any other 403 is not a refusal either.
    const text = await shortText(response);
    if (/quota/i.test(text)) {
      // A .NET TimeSpan: "hh:mm:ss", or "d.hh:mm:ss" past a day.
      const wait = /replenished in (?:(\d{1,3})\.)?(\d{1,2}):(\d\d):(\d\d)/i.exec(text);
      const retryAfter = wait
        ? (((Number(wait[1] ?? 0) * 24 + Number(wait[2])) * 60 + Number(wait[3])) * 60 +
            Number(wait[4])) *
          1000
        : retryAfterMs(
            response.headers?.get?.('retry-after'),
            Number.isFinite(served) ? served : now(),
          );
      throw new SourceError('rate_limited', 'The AESO API quota is used up (403)', {
        status,
        retryAfter,
      });
    }
    throw new SourceError('forbidden', 'The AESO API answered 403', { status });
  }
  await response.body?.cancel?.().catch(() => {});
  if (status === 429) {
    // An HTTP date is compared to the server's own clock (its Date header) when it gives one.
    throw new SourceError('rate_limited', 'The AESO API asked to slow down (429)', {
      status,
      retryAfter: retryAfterMs(
        response.headers?.get?.('retry-after'),
        Number.isFinite(served) ? served : now(),
      ),
    });
  }
  if (status === 404 || status === 410) {
    throw new SourceError('retired', `The AESO Pool Price API v1.1 answered ${status} (retired?)`, {
      status,
    });
  }
  if (status >= 500) {
    throw new SourceError('server', `The AESO API answered ${status}`, { status });
  }
  throw new SourceError('http', `The AESO API answered ${status}`, { status });
}
