// -----------------------------------------------------------------------------
// The configuration of the form, normalized: the AESO API key (the "public"
// subscription key of the AESO developer portal). Nothing here talks to the
// network, and the key is never part of a message.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { CONFIG_KEY, MAX_KEY_LENGTH, MIN_KEY_LENGTH } from './constants.js';

/** Printable ASCII without space: never a control character (CR, LF, tab) in a header. */
const KEY = /^[\x21-\x7e]+$/;

/** `{ key, problem }`: `problem` ('missing', 'malformed') keeps anything from being sent. */
export function normalizeConfig(raw) {
  const value = raw && typeof raw === 'object' ? raw[CONFIG_KEY] : undefined;
  if (value === undefined || value === null) return { key: '', problem: 'missing' };
  if (typeof value !== 'string') return { key: '', problem: 'malformed' };
  const key = value.trim();
  if (!key) return { key: '', problem: 'missing' };
  if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH || !KEY.test(key)) {
    return { key: '', problem: 'malformed' };
  }
  return { key, problem: undefined };
}

/**
 * 8 bits of a salted hash of a refused key: enough to keep a restart from
 * sending the same key again, nothing to find it back from (one key in 256
 * shares any tag).
 */
export const tagOf = (salt, key) =>
  createHash('sha256').update(`${salt}\u0000${key}`, 'utf8').digest()[0];

/** A refusal read back from /data: `{ salt, tag }`, or undefined. */
export function validRefused(value) {
  return value &&
    typeof value === 'object' &&
    typeof value.salt === 'string' &&
    /^[0-9a-f]{32}$/.test(value.salt) &&
    Number.isInteger(value.tag) &&
    value.tag >= 0 &&
    value.tag < 256
    ? { salt: value.salt, tag: value.tag }
    : undefined;
}
