import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  identityOf,
  readIdentityFromCache,
  registerIdentityObserver,
  registerIdentityReader,
  registerIdentitySource,
  type AccountSighting,
  type KnownIdentity,
} from '../src/store/identity.js';
import { Ledger } from '../src/ledger/log.js';
import type { StoreLayout } from '../src/domain/types.js';
import { makeStore } from './helpers/store.js';

/**
 * The three identity extension points: a source that remembers, an observer
 * told of every fresh sighting, and a reader that completes the fresh read.
 * With none registered, `identityOf` is the fresh read and nothing more.
 */

const ACCOUNT = '00000000-0000-4000-8000-0000000000ac';
const OTHER = '00000000-0000-4000-8000-0000000000bd';

let store: StoreLayout;
let ledger: Ledger;
let undo: (() => void)[] = [];

function signedInAs(accountUuid: string) {
  writeFileSync(store.configFile, JSON.stringify({ lastKnownAccountUuid: accountUuid }), 'utf8');
}

function cachedProfile(accountUuid: string, email: string, name: string) {
  const dir = path.join(store.root, 'Cache', 'Cache_Data');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `f_${accountUuid.slice(-6)}`),
    gzipSync(JSON.stringify({ account: { uuid: accountUuid, full_name: name, email } })),
  );
}

beforeEach(() => {
  store = makeStore();
  ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'homecoming-idx-')), 'l.jsonl'));
  undo = [];
});

afterEach(() => {
  for (const step of undo.reverse()) step();
});

describe('identityOf without extensions', () => {
  it('is the fresh read for the account signed in', () => {
    signedInAs(ACCOUNT);
    cachedProfile(ACCOUNT, 'john@example.com', 'John');

    expect(identityOf(store, ACCOUNT, ledger)).toEqual({ email: 'john@example.com', name: 'John' });
  });

  it('knows nothing about an account that is not signed in', () => {
    signedInAs(ACCOUNT);
    cachedProfile(OTHER, 'other@example.com', 'Other');

    expect(identityOf(store, OTHER, ledger)).toBeUndefined();
  });
});

describe('identity sources', () => {
  it('answer when the cache is empty, marked remembered with their seenAt', () => {
    signedInAs(ACCOUNT);
    undo.push(
      registerIdentitySource((uuid) =>
        uuid === OTHER ? { email: 'kept@example.com', seenAt: 1000 } : undefined,
      ),
    );

    expect(identityOf(store, OTHER, ledger)).toEqual({
      email: 'kept@example.com',
      remembered: true,
      seenAt: 1000,
    });
  });

  it('lose to a fresh cache, which fills what it found', () => {
    signedInAs(ACCOUNT);
    cachedProfile(ACCOUNT, 'fresh@example.com', 'Fresh');
    undo.push(
      registerIdentitySource(() => ({
        email: 'stale@example.com',
        name: 'Stale',
        seenAt: 5,
      })),
    );

    const identity = identityOf(store, ACCOUNT, ledger);
    expect(identity).toEqual({
      email: 'fresh@example.com',
      name: 'Fresh',
    });
    expect(identity?.remembered).toBeUndefined();
  });

  it('are ranked by the most recent seenAt, and one that throws is skipped', () => {
    undo.push(registerIdentitySource(() => ({ email: 'old@example.com', seenAt: 10 })));
    undo.push(
      registerIdentitySource(() => {
        throw new Error('broken');
      }),
    );
    undo.push(registerIdentitySource(() => ({ email: 'new@example.com', seenAt: 20 })));

    expect(identityOf(store, OTHER, ledger)?.email).toBe('new@example.com');
  });
});

describe('identity readers', () => {
  it('never overwrite the email and name the core read', () => {
    signedInAs(ACCOUNT);
    cachedProfile(ACCOUNT, 'john@example.com', 'John');
    undo.push(
      registerIdentityReader(() => ({
        email: 'reader@example.com',
        name: 'Reader',
      })),
    );

    expect(readIdentityFromCache(store, ACCOUNT)).toEqual({
      email: 'john@example.com',
      name: 'John',
    });
  });

  it('carry only an email and a name, whatever else they hand back', () => {
    signedInAs(ACCOUNT);
    undo.push(
      registerIdentityReader(
        () => ({ name: 'Reader', extra: 'dropped' }) as unknown as { name: string },
      ),
    );

    expect(readIdentityFromCache(store, ACCOUNT)).toEqual({ name: 'Reader' });
  });

  it('are asked about every account, and one that throws is skipped', () => {
    signedInAs(ACCOUNT);
    undo.push(
      registerIdentityReader(() => {
        throw new Error('broken');
      }),
    );
    undo.push(registerIdentityReader((_store, uuid) => (uuid === OTHER ? { name: 'Other' } : {})));

    expect(identityOf(store, OTHER, ledger)).toEqual({ name: 'Other' });
  });
});

describe('identity observers', () => {
  it('are told only of a fresh read that found something', () => {
    signedInAs(ACCOUNT);
    cachedProfile(ACCOUNT, 'john@example.com', 'John');
    const seen: [string, AccountSighting][] = [];
    undo.push(
      registerIdentityObserver({
        name: 'recorder',
        onIdentitySeen: (uuid, identity) => seen.push([uuid, identity]),
      }),
    );
    undo.push(registerIdentitySource(() => ({ email: 'kept@example.com', seenAt: 1 })));

    identityOf(store, ACCOUNT, ledger);
    // Not signed in: nothing fresh, only the remembered answer, so no sighting.
    identityOf(store, OTHER, ledger);

    expect(seen).toEqual([[ACCOUNT, { email: 'john@example.com', name: 'John' }]]);
  });

  it('that throw do not take identityOf down, nor keep later observers from hearing', () => {
    signedInAs(ACCOUNT);
    cachedProfile(ACCOUNT, 'john@example.com', 'John');
    const heard: string[] = [];
    undo.push(
      registerIdentityObserver({
        name: 'broken',
        onIdentitySeen: () => {
          throw new Error('broken');
        },
      }),
    );
    undo.push(registerIdentityObserver({ name: 'ok', onIdentitySeen: (uuid) => heard.push(uuid) }));

    expect(identityOf(store, ACCOUNT, ledger)?.email).toBe('john@example.com');
    expect(heard).toEqual([ACCOUNT]);
  });
});

describe('unregistering', () => {
  it('takes every source, reader and observer away again', () => {
    signedInAs(ACCOUNT);
    const heard: string[] = [];
    const known: KnownIdentity = { email: 'kept@example.com', seenAt: 1 };
    const steps = [
      registerIdentitySource(() => known),
      registerIdentityReader(() => ({ name: 'Reader' })),
      registerIdentityObserver({ name: 'ear', onIdentitySeen: (uuid) => heard.push(uuid) }),
    ];
    expect(identityOf(store, ACCOUNT, ledger)).toMatchObject({ email: 'kept@example.com' });
    expect(heard).toEqual([ACCOUNT]);

    for (const step of steps) step();
    heard.length = 0;

    expect(identityOf(store, ACCOUNT, ledger)).toBeUndefined();
    expect(readIdentityFromCache(store, ACCOUNT)).toBeUndefined();
    expect(heard).toEqual([]);
  });
});
