import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  knownStores,
  registerStoreProvider,
  resolveStoreArg,
  type StoreProvider,
} from '../src/engine/stores.js';
import { registerCredentialProbe } from '../src/store/config.js';
import type { LedgerEvent } from '../src/ledger/types.js';
import type { StoreLayout } from '../src/domain/types.js';
import { makeStore, NEW_ACCOUNT } from './helpers/store.js';

/**
 * Which installations can be named without being told. Getting this wrong is
 * quiet: a directory listed twice reads as a second installation that does not
 * exist, and a typo resolved to an empty store reads like a store with nothing
 * in it.
 */

function labelled(accountUuid: string, label: string): LedgerEvent {
  return {
    v: 1,
    ts: 1_700_000_000_000,
    toolVersion: '0.0.0-test',
    kind: 'account_labelled',
    accountUuid,
    label,
  };
}

/** A store signed into the given account. */
function signedInto(accountUuid: string): StoreLayout {
  const store = makeStore();
  writeFileSync(store.configFile, JSON.stringify({ lastKnownAccountUuid: accountUuid }), 'utf8');
  return store;
}

const cleanups: (() => void)[] = [];
function provide(...entries: { root: string; name?: string }[]): void {
  const provider: StoreProvider = () => entries;
  cleanups.push(registerStoreProvider(provider));
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

/**
 * A machine carrying both a packaged (`Packages\Claude_<hash>\...`) store and a
 * plain `%APPDATA%\Claude` one: two real temp directories, so `directoryKey`
 * reports two distinct device/inode pairs the way it would outside the app's
 * container.
 */
function makeSideBySideStores(): {
  packagedRoot: string;
  appDataRoot: string;
  env: NodeJS.ProcessEnv;
} {
  const base = mkdtempSync(path.join(tmpdir(), 'homecoming-msix-'));
  const packagedRoot = path.join(
    base,
    'Local',
    'Packages',
    'Claude_pzs8sxrjxfjjc',
    'LocalCache',
    'Roaming',
    'Claude',
  );
  mkdirSync(path.join(packagedRoot, 'claude-code-sessions'), { recursive: true });
  const appDataRoot = path.join(base, 'Roaming', 'Claude');
  mkdirSync(path.join(appDataRoot, 'claude-code-sessions'), { recursive: true });
  return {
    packagedRoot,
    appDataRoot,
    env: { LOCALAPPDATA: path.join(base, 'Local'), APPDATA: path.join(base, 'Roaming') },
  };
}

describe('knownStores', () => {
  it('knows nothing on a machine with no installation and no provider', () => {
    expect(knownStores([], {})).toEqual([]);
  });

  it('offers what a provider offers, with the account it last recorded', () => {
    const store = signedInto(NEW_ACCOUNT.accountUuid);
    provide({ root: store.root, name: 'work' });

    expect(knownStores([], {})).toEqual([
      {
        root: store.root,
        name: 'work',
        hint: 'provided',
        running: false,
        exists: true,
        accountUuid: NEW_ACCOUNT.accountUuid,
      },
    ]);
  });

  it('names one directory once, however many providers lead to it', () => {
    const store = makeStore();
    provide({ root: store.root });
    provide({ root: store.root, name: 'again' });

    const found = knownStores([], {});
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ root: store.root, name: 'again' });
  });

  it('keeps a named provided store that has gone, marked exists: false', () => {
    const gone = path.join(tmpdir(), 'homecoming-provided-gone-that-does-not-exist');
    provide({ root: gone, name: 'work' });

    expect(knownStores([], {})).toEqual([
      { root: path.resolve(gone), name: 'work', hint: 'provided', running: false, exists: false },
    ]);
  });

  it('drops an unnamed provided store that has gone', () => {
    provide({ root: path.join(tmpdir(), 'homecoming-unnamed-gone-that-does-not-exist') });
    expect(knownStores([], {})).toEqual([]);
  });

  it('stops offering a provider once it is unregistered', () => {
    const store = makeStore();
    provide({ root: store.root });
    expect(knownStores([], {})).toHaveLength(1);
    cleanups.pop()!();
    expect(knownStores([], {})).toEqual([]);
  });

  it('does not report a cached login: the core never looks', () => {
    const store = makeStore();
    const opaque = 'SHOULD-NEVER-BE-READ-fdd93c2b8a1e';
    writeFileSync(store.configFile, JSON.stringify({ 'oauth:tokenCacheV2': opaque }), 'utf8');
    provide({ root: store.root });

    const found = knownStores([], {});
    expect(found[0]?.hasTokenCache).toBeUndefined();
    expect(JSON.stringify(found)).not.toContain(opaque);
  });

  it('reports a cached login when a probe says one is present, still without the blob', () => {
    const store = makeStore();
    const opaque = 'SHOULD-NEVER-BE-READ-fdd93c2b8a1e';
    writeFileSync(store.configFile, JSON.stringify({ 'oauth:tokenCacheV2': opaque }), 'utf8');
    provide({ root: store.root });
    const undo = registerCredentialProbe({ name: 'test', hasTokenCache: () => true });
    try {
      const found = knownStores([], {});
      expect(found[0]?.hasTokenCache).toBe(true);
      expect(JSON.stringify(found)).not.toContain(opaque);
    } finally {
      undo();
    }
  });

  it('flags the pre-MSIX %APPDATA%\\Claude row when a packaged install sits beside it', () => {
    const { packagedRoot, appDataRoot, env } = makeSideBySideStores();

    const found = knownStores([], env);

    expect(found).toHaveLength(2);
    expect(
      found.find((known) => known.root === path.resolve(packagedRoot))?.legacy,
    ).toBeUndefined();
    expect(found.find((known) => known.root === path.resolve(appDataRoot))?.legacy).toBe(true);
    expect(found.every((known) => known.hint === 'installed app')).toBe(true);
  });

  it('does not flag a lone %APPDATA%\\Claude with no packaged install anywhere', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'homecoming-plain-'));
    const appDataRoot = path.join(base, 'Roaming', 'Claude');
    mkdirSync(path.join(appDataRoot, 'claude-code-sessions'), { recursive: true });

    const found = knownStores([], {
      LOCALAPPDATA: path.join(base, 'Local'),
      APPDATA: path.join(base, 'Roaming'),
    });

    expect(found).toHaveLength(1);
    expect(found[0]!.root).toBe(path.resolve(appDataRoot));
    expect(found[0]!.legacy).toBeUndefined();
  });
});

describe('what --store names', () => {
  it('takes a directory that exists as a directory', () => {
    const store = makeStore();
    expect(resolveStoreArg(store.root, () => [], {}).root).toBe(store.root);
  });

  it('resolves a provided name, case-insensitively, before a path piece', () => {
    const named = makeStore();
    const decoy = mkdtempSync(path.join(tmpdir(), 'work-decoy-'));
    provide({ root: named.root, name: 'work' }, { root: decoy });

    expect(resolveStoreArg('WORK', () => [], {}).root).toBe(named.root);
  });

  it('says which store went missing when a name points at a gone directory', () => {
    provide({ root: path.join(tmpdir(), 'homecoming-named-gone-that-does-not-exist'), name: 'w' });
    expect(() => resolveStoreArg('w', () => [], {})).toThrow(
      /store "w" is known at .*, which is gone/,
    );
  });

  it('accepts a distinctive piece of a known path', () => {
    const store = makeStore();
    provide({ root: store.root });
    const piece = path.basename(path.dirname(store.root)).slice(-8);

    expect(resolveStoreArg(piece, () => [], {}).root).toBe(store.root);
  });

  it('refuses a piece that matches two installations', () => {
    const one = mkdtempSync(path.join(tmpdir(), 'homecoming-twin-'));
    const two = mkdtempSync(path.join(tmpdir(), 'homecoming-twin-'));
    provide({ root: one }, { root: two });

    expect(() => resolveStoreArg('homecoming-twin-', () => [], {})).toThrow(
      /matches 2 installations/,
    );
  });

  it('resolves an account label to the only store last seen with it', () => {
    const store = signedInto(NEW_ACCOUNT.accountUuid);
    provide({ root: store.root });

    const found = resolveStoreArg('work', () => [labelled(NEW_ACCOUNT.accountUuid, 'work')], {});
    expect(found.root).toBe(store.root);
  });

  it('resolves a unique uuid prefix to the store last seen with that account', () => {
    const store = signedInto(NEW_ACCOUNT.accountUuid);
    provide({ root: store.root });

    const found = resolveStoreArg(NEW_ACCOUNT.accountUuid.slice(0, 8), () => [], {});
    expect(found.root).toBe(store.root);
  });

  it('refuses a label two stores were last seen with', () => {
    const one = signedInto(NEW_ACCOUNT.accountUuid);
    const two = signedInto(NEW_ACCOUNT.accountUuid);
    provide({ root: one.root }, { root: two.root });

    expect(() =>
      resolveStoreArg('work', () => [labelled(NEW_ACCOUNT.accountUuid, 'work')], {}),
    ).toThrow(/names an account last seen by 2 installations/);
  });

  it('says so rather than resolving a typo to an empty store', () => {
    expect(() => resolveStoreArg('nowhere-at-all', () => [], {})).toThrow(/not a directory/);
  });
});
