import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { StoreLayout } from '../domain/types.js';
import type { Ledger } from '../ledger/log.js';
import { isDirectory, safeReaddir } from '../util/fs.js';
import { readConfig } from '../store/config.js';
import { readAccountFromResponseCache } from './responseCache.js';

/** Removes what a `register*` call added. */
type Unregister = () => void;

/**
 * What is known about who an account belongs to, from any one look at it.
 *
 * An email and a display name, and nothing else: the core reads them from the
 * app's cache, and a registered reader or source can only fill the same two.
 */
export interface AccountSighting {
  email?: string;
  name?: string;
}

/** Who an account belongs to, as far as the app's own cache (and any reader) says. */
export type CachedIdentity = AccountSighting;

/** A sighting remembered from an earlier run, dated. */
export type KnownIdentity = AccountSighting & {
  /** When any part of this was last confirmed. */
  seenAt: number;
};

/** The identity to show: fresh cache, remembered, or both. */
export type ResolvedIdentity = AccountSighting & {
  /** True when nothing was in the cache and every part was remembered. */
  remembered?: boolean;
  /** When the remembered part was last confirmed, for anything not read fresh. */
  seenAt?: number;
};

function registry<T>(): { items: T[]; add(item: T): Unregister } {
  const items: T[] = [];
  return {
    items,
    add(item: T): Unregister {
      items.push(item);
      return () => {
        const at = items.indexOf(item);
        if (at >= 0) items.splice(at, 1);
      };
    },
  };
}

/**
 * A further place to read an account's identity from at rest, beside the app's
 * cache. Consulted by `readIdentityFromCache` after the core read, in
 * registration order, and only for the fields still empty: a reader never
 * overwrites what the core (or an earlier reader) found. One that throws is
 * skipped.
 */
export type IdentityReader = (
  store: StoreLayout,
  accountUuid: string,
) => Partial<AccountSighting> | undefined;

const readers = registry<IdentityReader>();

export function registerIdentityReader(reader: IdentityReader): Unregister {
  return readers.add(reader);
}

/**
 * Somewhere an earlier sighting was kept, usually the plugin's own ledger slot.
 * `identityOf` falls back to the one with the most recent `seenAt` for anything
 * the fresh read did not find. The core keeps no memory of its own, so without
 * a source the answer is exactly the fresh read.
 */
export type IdentitySource = (accountUuid: string, ledger: Ledger) => KnownIdentity | undefined;

const sources = registry<IdentitySource>();

export function registerIdentitySource(source: IdentitySource): Unregister {
  return sources.add(source);
}

/**
 * Told whenever a fresh read found something about an account, so a plugin can
 * write the sighting down (and later answer for it as an `IdentitySource`).
 * Called only when the read brought something back, never for a remembered
 * answer; one that throws is isolated from the read and from other observers.
 */
export interface IdentityObserver {
  name: string;
  onIdentitySeen(accountUuid: string, identity: AccountSighting, ledger: Ledger): void;
}

const observers = registry<IdentityObserver>();

export function registerIdentityObserver(observer: IdentityObserver): Unregister {
  return observers.add(observer);
}

const SIGHTING_FIELDS = ['email', 'name'] as const;

function hasAnything(identity: Partial<AccountSighting> | undefined): boolean {
  return Boolean(identity && SIGHTING_FIELDS.some((field) => Boolean(identity[field])));
}

/** Only the sighting fields, each kept when present. */
function sightingOf(identity: Partial<AccountSighting> | undefined): AccountSighting {
  const out: AccountSighting = {};
  if (!identity) return out;
  if (identity.email) out.email = identity.email;
  if (identity.name) out.name = identity.name;
  return out;
}

/** The core read, completed field by field by every registered reader. */
function withReaders(
  store: StoreLayout,
  accountUuid: string,
  core: CachedIdentity | undefined,
): CachedIdentity | undefined {
  if (readers.items.length === 0) return core;
  const merged: AccountSighting = sightingOf(core);
  for (const reader of readers.items) {
    let extra: Partial<AccountSighting> | undefined;
    try {
      extra = reader(store, accountUuid);
    } catch {
      continue;
    }
    const found = sightingOf(extra);
    merged.email ??= found.email;
    merged.name ??= found.name;
  }
  const out = sightingOf(merged);
  return hasAnything(out) ? out : undefined;
}

/**
 * Everything known about an account: the fresh read, told to every observer
 * when it found anything, then completed from the registered source that saw
 * the account most recently.
 *
 * The fresh read of the app's cache is made only for the account signed in:
 * the cache describes that session and no other, so asking it about the rest
 * would either answer nothing or answer with the wrong profile. Readers are
 * asked about every account, because what they read is theirs to scope.
 */
export function identityOf(
  store: StoreLayout,
  accountUuid: string,
  ledger: Ledger,
): ResolvedIdentity | undefined {
  let signedIn: string | undefined;
  try {
    signedIn = readConfig(store).lastKnownAccountUuid;
  } catch {
    signedIn = undefined;
  }
  const core = signedIn === accountUuid ? coreIdentity(store, accountUuid) : undefined;
  const fresh = withReaders(store, accountUuid, core);

  if (hasAnything(fresh)) {
    const sighting = sightingOf(fresh);
    for (const observer of observers.items) {
      try {
        observer.onIdentitySeen(accountUuid, sighting, ledger);
      } catch {
        // An observer is told, not obeyed: its failure never changes the answer.
      }
    }
  }

  let known: KnownIdentity | undefined;
  for (const source of sources.items) {
    let found: KnownIdentity | undefined;
    try {
      found = source(accountUuid, ledger);
    } catch {
      continue;
    }
    if (!found || !hasAnything(found) || !Number.isFinite(found.seenAt)) continue;
    if (!known || found.seenAt > known.seenAt) known = found;
  }

  return resolveIdentity(fresh, known);
}

/**
 * The human name behind an account UUID, read from the app's own cache.
 *
 * The account's email and display name are not in any file homecoming is allowed to
 * read outright: the token cache is a credential, and the authoritative copy is
 * behind the API. But the app, having fetched its own profile once, keeps a copy
 * at rest, in the web-origin storage under `Local Storage/` and `IndexedDB/`.
 * That copy is cached page data, the same category as the session files, so it
 * can be read.
 *
 * It is read the crudest way on purpose: every candidate file is loaded as bytes,
 * capped by size, and searched as text. An earlier version parsed the Local
 * Storage LevelDB with the same reader homecoming uses for the pin list — and that
 * reader, written for one narrow database, corrupted the heap on a real Local
 * Storage table and took the process down with a status no `try` can catch
 * (0xC0000374). Parsing the app's storage means trusting a format that is the
 * app's to change; reading bytes and looking for an email trusts nothing. It
 * finds less — a value that only exists inside a compressed block is missed — but
 * it cannot crash, and a best-effort read that crashes is not best-effort.
 *
 * Two honesties beyond that. It is best-effort: a version that stores the profile
 * differently makes this find nothing rather than something wrong, and the manual
 * `label` is always there. And what this file reads describes only the account
 * signed in now, because web storage belongs to the current session — the other
 * accounts are known through the ledger, which keeps what was seen on the visit
 * that saw it, so a name is available for an account you are not in.
 */

/**
 * The identity to use, from the cache when it says something and from memory
 * when it does not.
 *
 * This is the answer to a source that cannot be read more carefully, only more
 * often. The profile lands in the app's web storage on sign-in and leaves when
 * Chromium compacts that database — the plan was readable here minutes after
 * signing in and absent from every non-credential file an hour later — so a
 * command that only reads gets a different answer depending on when it runs.
 * Reading and *remembering* turns that into a stable one: whatever the cache
 * still offers wins, because it is current, and anything it has forgotten falls
 * back to what homecoming wrote down when it was there.
 */
export function resolveIdentity(
  cached: CachedIdentity | undefined,
  known: KnownIdentity | undefined,
): ResolvedIdentity | undefined {
  if (!cached && !known) return undefined;

  const fresh = sightingOf(cached);
  const remembered = sightingOf(known);
  const merged: ResolvedIdentity = {
    ...((fresh.email ?? remembered.email) ? { email: fresh.email ?? remembered.email } : {}),
    ...((fresh.name ?? remembered.name) ? { name: fresh.name ?? remembered.name } : {}),
  };
  if (!hasAnything(merged)) return undefined;

  // Only called remembered when the cache contributed nothing at all. A partial
  // read is still a fresh sighting of what it did find, and saying otherwise
  // would age the whole answer wrongly.
  if (!hasAnything(fresh) && known) return { ...merged, remembered: true, seenAt: known.seenAt };
  return merged;
}

/**
 * An address, shaped strictly enough that noise cannot spell one by accident: no
 * empty label, no doubled dot, and a trailing label that is letters only.
 */
const ADDRESS = String.raw`[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,24}`;
// The account's address specifically — read out of a field that says it is one,
// and never from a bare address sitting nearby.
//
// The bare pattern was the flaw, and the source is why. These are Snappy-
// compressed LevelDB blocks read as raw bytes, so most of what a pattern scans
// here is not text at all: across one real store, 350 of 676 matches for a plain
// address were decompression noise — `3@T.tf`, `v@I.rI`, `6@ai.television.ses`.
// One of those was recorded as an account's email and, the ledger being what it
// is, stayed. Requiring the key, and both quotes around the value, asks for
// something noise does not accidentally produce; distance alone never could,
// because the noise is nearest of all.
const EMAIL = new RegExp(
  String.raw`"(?:email|email_address|emailAddress|primary_email|primaryEmail|account_email|accountEmail)"\s*:\s*"(${ADDRESS})"`,
  'i',
);
// A person's name field specifically — not a bare `"name"`, which the app's cache
// attaches to organizations, workspaces and a dozen other things, and which is
// what once put a workspace called "Sales" where the account holder belonged.
const NAME = /"(?:full_name|fullName|display_name|displayName)"\s*:\s*"([^"]{1,80})"/;

/**
 * The account's identity from cache, or undefined when nothing can be tied to it.
 *
 * Two anchors, chosen for what each reliably sits beside. The email is tied to
 * the account's own UUID — the profile keeps them in one small object, while a
 * stranger's address quoted in a conversation is off in another record — and it
 * must additionally be written down as an email, under a field that names it.
 * Proximity alone was not enough: nearness is a claim about text, and half of
 * what these files hold is compressed bytes read as text, which is nearer to
 * everything than the profile ever is. The name
 * is then tied to the *email*, not the UUID: the cache is live app
 * state, thick with `name` fields for workspaces and organizations near the
 * account id, and only the email marks the one object that is actually the
 * person's. Anchoring the name to the id once labelled this account with a
 * workspace called "Sales"; anchoring it to the email does not.
 */
export function readIdentityFromCache(
  store: StoreLayout,
  accountUuid = readConfig(store).lastKnownAccountUuid,
): CachedIdentity | undefined {
  if (!accountUuid) return undefined;
  return withReaders(store, accountUuid, coreIdentity(store, accountUuid));
}

/** What the app's own cache says, before any registered reader is asked. */
function coreIdentity(store: StoreLayout, accountUuid: string): CachedIdentity | undefined {
  // The response cache first, because it holds the profile itself: an object
  // that names the account and carries its own email, so nothing is inferred
  // from proximity. The search below is the fallback, for a version that keeps
  // the profile somewhere else, or a cache already evicted.
  const fromResponse = readAccountFromResponseCache(store, accountUuid);
  if (fromResponse && (fromResponse.email || fromResponse.name)) return fromResponse;

  const needle = accountUuid.toLowerCase();
  const found: CachedIdentity = {};

  for (const text of readCandidateFiles(store)) {
    const uuids = occurrences(text, needle, true);
    const email = found.email ?? nearest(text, uuids, EMAIL, (m) => m[1], MAX_DISTANCE);
    if (email) found.email = email;

    // The profile object is the one that holds the account's email. The name is
    // read from beside it, a tight reach, because it shares the object. With no
    // email in this file there is no trustworthy anchor, so no name is guessed
    // from the id alone.
    const anchor = email ? occurrences(text, email) : [];
    if (anchor.length > 0) {
      found.name ??= nearest(text, anchor, NAME, (m) => m[1]?.trim(), NAME_DISTANCE);
    }
    if (found.email && found.name) return found;
  }

  return found.email || found.name ? found : undefined;
}

/**
 * The text of every file worth searching, each decoded a few plausible ways.
 *
 * Both stores are read the same crude way — bytes, size-capped — because neither
 * is parsed. Local Storage is small and holds the display name; the IndexedDB
 * blob tree holds the large values, the email among them, as plain files. The
 * IndexedDB LevelDB itself is skipped: it is the conversation database, big and
 * the source of the crash, and nothing here needs it.
 */
function* readCandidateFiles(store: StoreLayout): Generator<string> {
  const localStorage = path.join(store.root, 'Local Storage', 'leveldb');
  for (const name of safeReaddir(localStorage)) {
    if (name.endsWith('.ldb') || name.endsWith('.log')) {
      yield* readFileText(path.join(localStorage, name));
    }
  }

  yield* walkBlobs(path.join(store.root, 'IndexedDB', 'https_claude.ai_0.indexeddb.blob'), {
    files: MAX_BLOB_FILES,
  });
}

/** The blob tree, walked breadth-unaware but bounded, each file read as text. */
function* walkBlobs(root: string, budget: { files: number }): Generator<string> {
  for (const entry of safeReaddir(root)) {
    if (budget.files <= 0) return;
    const full = path.join(root, entry);
    try {
      if (isDirectory(full)) {
        yield* walkBlobs(full, budget);
        continue;
      }
    } catch {
      continue;
    }
    budget.files -= 1;
    yield* readFileText(full);
  }
}

/**
 * A file's bytes, decoded to the strings they might be — or nothing.
 *
 * Size-capped before it is opened: a file past the limit is a conversation store
 * or a document, never a profile record, and reading it is the memory the crude
 * approach exists to avoid spending. The bytes are offered as UTF-8 and as
 * UTF-16LE because Chromium stores strings both ways; a wrong decoding simply
 * fails to match the patterns.
 */
function* readFileText(file: string): Generator<string> {
  try {
    if (fileSize(file) > MAX_FILE_BYTES) return;
    trace(`${path.basename(file)} (${fileSize(file)} bytes)`);
    const bytes = readFileSync(file);
    yield bytes.toString('latin1');
    yield bytes.toString('utf16le');
  } catch {
    // A file that vanished, is locked, or cannot be read is skipped; the search
    // across the rest is what matters, and its failure is not an error.
  }
}

/**
 * The match closest to one of the anchor strings, if it is close enough.
 *
 * Closeness is the whole safeguard. What is being read sits beside its anchor in
 * one small object; the same field for something else — a workspace's name, a
 * stranger's address — is in another record, further away. Taking the match
 * nearest an anchor, and only within a bound, keeps the wrong one from winning in
 * a way a plain "somewhere in the same file" cannot. The anchors are the
 * positions of a string already located: the account id for the email, the email
 * for the name.
 */
function nearest(
  text: string,
  anchors: { at: number; length: number }[],
  pattern: RegExp,
  pick: (match: RegExpExecArray) => string | undefined,
  maxDistance: number,
): string | undefined {
  if (anchors.length === 0) return undefined;

  const source = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g',
  );
  let best: { value: string; distance: number } | undefined;

  for (let match = source.exec(text); match; match = source.exec(text)) {
    const value = pick(match);
    if (!value) continue;
    // Between spans, not between start points: an anchor can be many characters
    // long, so a field beside it but after it starts far from its beginning while
    // a neighbour before it starts near — measuring start-to-start would prefer
    // the neighbour. The gap between the two spans is what "beside" really means.
    const start = match.index;
    const end = match.index + match[0].length;
    const distance = Math.min(...anchors.map((a) => gap(a.at, a.at + a.length, start, end)));
    if (distance <= maxDistance && (!best || distance < best.distance)) {
      best = { value, distance };
    }
  }

  return best?.value;
}

/** The number of characters between two spans, or 0 when they touch or overlap. */
function gap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, bStart - aEnd, aStart - bEnd);
}

/** Every occurrence of a substring, as anchor spans. Case-insensitive when asked. */
function occurrences(text: string, sub: string, fold = false): { at: number; length: number }[] {
  const haystack = fold ? text.toLowerCase() : text;
  const needle = fold ? sub.toLowerCase() : sub;
  const out: { at: number; length: number }[] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    out.push({ at, length: needle.length });
  }
  return out;
}

/**
 * How far from the account id its email may be. A profile object — id, email,
 * name and a few fields — is a few hundred characters, so an email beyond this is
 * in another record and not the account's.
 */
const MAX_DISTANCE = 600;

/** How far from the email its owner's name may be. They share one small object. */
const NAME_DISTANCE = 300;

/**
 * The largest file this will read. Nothing being looked for lives in a big file;
 * a big file is a conversation store or a stored document, and loading one is the
 * cost — in memory, and in the crash that motivated all of this — that reading
 * bytes crudely is meant to avoid.
 */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** How many blob files the walk will look at before giving up — a bound, not a target. */
const MAX_BLOB_FILES = 4000;

function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * A breadcrumb before each file is opened, printed only when FOSTER_DEBUG is set.
 *
 * The read can be killed in a way no `try` catches — a heap fault, an
 * out-of-memory abort, a security tool that mistakes reading browser storage for
 * theft — and a crash that leaves no error is diagnosable only by what was about
 * to be read. The last line this prints before silence names the file that did it.
 */
function trace(message: string): void {
  if (process.env.FOSTER_DEBUG) process.stderr.write(`[foster] ${message}\n`);
}

/**
 * A one-line label from an identity, or undefined when there is nothing: name
 * and email joined by the middle dot the app itself uses, each dropped when
 * absent.
 */
export function identityLabel(identity: CachedIdentity | undefined): string | undefined {
  if (!identity) return undefined;
  const parts = [identity.name, identity.email].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}
