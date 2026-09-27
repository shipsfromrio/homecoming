import { readFileSync, statSync } from 'node:fs';
import { brotliDecompressSync, constants, gunzipSync } from 'node:zlib';
import path from 'node:path';
import type { StoreLayout } from '../domain/types.js';
import { isDirectory, safeReaddir } from '../util/fs.js';

/**
 * The signed-in account's name and e-mail, read out of the app's HTTP response
 * cache.
 *
 * The same category of file as the web storage next door: a copy the app kept
 * of something it fetched, not a credential. The bodies are gzip- or
 * brotli-compressed, so scanning bytes for text finds nothing; once
 * decompressed they are JSON, so they are parsed rather than pattern-matched.
 * An object either carries `account.uuid` equal to the account being asked
 * about or it does not, which is a fact rather than a guess.
 *
 * Only the account signed in now is ever found here: the app only fetches the
 * profile of the session it is in.
 */
export function readAccountFromResponseCache(
  store: StoreLayout,
  accountUuid: string | undefined,
): { email?: string; name?: string } | undefined {
  if (!accountUuid) return undefined;
  const wanted = accountUuid.toLowerCase();

  for (const value of cachedJson(store)) {
    const account = asRecord(value.account);
    if (typeof account?.uuid !== 'string' || account.uuid.toLowerCase() !== wanted) continue;
    const email = account.email ?? account.email_address;
    const name = account.full_name;
    return {
      ...(typeof email === 'string' && email ? { email } : {}),
      ...(typeof name === 'string' && name ? { name } : {}),
    };
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Every JSON object the response cache holds, decompressed: as it lies,
 * gunzipped from each point a gzip member begins (a body stored inside a larger
 * block file starts partway in), and brotli-decompressed whole.
 */
function* cachedJson(store: StoreLayout): Generator<Record<string, unknown>> {
  const budget = { files: MAX_FILES };
  for (const file of cacheFiles(path.join(store.root, 'Cache', 'Cache_Data'), budget)) {
    let bytes: Buffer;
    try {
      if (statSync(file).size > MAX_FILE_BYTES) continue;
      bytes = readFileSync(file);
    } catch {
      continue;
    }

    for (const body of decompressions(bytes)) {
      const value = parseJson(body);
      if (value) yield value;
    }
  }
}

function* decompressions(bytes: Buffer): Generator<string> {
  yield bytes.toString('utf8');

  for (let at = 0; at + 3 <= bytes.length; at++) {
    // The gzip member header: magic, then the one compression method that exists.
    if (bytes[at] !== 0x1f || bytes[at + 1] !== 0x8b || bytes[at + 2] !== 0x08) continue;
    try {
      // A member inside a block file is followed by whatever came next, so the
      // stream ends early on purpose; a sync flush accepts that.
      yield gunzipSync(bytes.subarray(at), {
        finishFlush: constants.Z_SYNC_FLUSH,
      }).toString('utf8');
    } catch {
      // Not a gzip member after all — the magic occurs in ordinary data too.
    }
  }

  try {
    yield brotliDecompressSync(bytes, {
      finishFlush: constants.BROTLI_OPERATION_FLUSH,
    }).toString('utf8');
  } catch {
    // Not brotli.
  }
}

/** A JSON object from text that is usually not JSON at all; the cheap check first. */
function parseJson(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{');
  if (start === -1 || start > 64) return undefined;
  if (!text.includes('"account"')) return undefined;
  try {
    const value: unknown = JSON.parse(text.slice(start).trim());
    return asRecord(value);
  } catch {
    return undefined;
  }
}

function* cacheFiles(root: string, budget: { files: number }): Generator<string> {
  for (const entry of safeReaddir(root)) {
    if (budget.files <= 0) return;
    const full = path.join(root, entry);
    try {
      if (isDirectory(full)) {
        yield* cacheFiles(full, budget);
        continue;
      }
    } catch {
      continue;
    }
    budget.files -= 1;
    yield full;
  }
}

/** The cache holds whole media files; a profile response is a few hundred bytes. */
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 2000;
