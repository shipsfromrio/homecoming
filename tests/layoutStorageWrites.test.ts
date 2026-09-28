import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StoreLayout } from '../src/domain/types.js';
import {
  applyLayout,
  LayoutWriteError,
  pendingLayoutCounts,
  planLayout,
  registerLayoutStorageWrite,
  totalLayoutPending,
  type LayoutStorageWrite,
} from '../src/engine/layout.js';
import { Ledger } from '../src/ledger/log.js';
import {
  decodeBatch,
  encodeBatch,
  encodeVarint32,
  frameRecords,
  readLog,
} from '../src/store/format/leveldb.js';
import { groupCardId, scopeKey } from '../src/store/groupScopes.js';
import {
  localStorageDir,
  localStorageKey,
  readLocalStorageText,
} from '../src/store/localStorage.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

/**
 * Registered Local Storage writes: text a plugin wants in a key of the app's
 * Local Storage, written by `applyLayout` in the closed-app gap, in the same
 * batch and behind the same backup as the groups' own two keys. With none
 * registered, the layout writes what it always did.
 */

const LOG_NUMBER = 4;
const PLUGIN_KEY = 'plugin-owned-key';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});
function register(write: LayoutStorageWrite): void {
  cleanups.push(registerLayoutStorageWrite(write));
}

function logPath(store: StoreLayout): string {
  return path.join(localStorageDir(store), `${String(LOG_NUMBER).padStart(6, '0')}.log`);
}

/** A Local Storage database with an empty log. */
function makeDatabase(store: StoreLayout, seed: Record<string, string> = {}): void {
  const dir = localStorageDir(store);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'CURRENT'), 'MANIFEST-000001\n');
  const edit = Buffer.concat([
    encodeVarint32(1),
    encodeVarint32(8),
    Buffer.from('idb_cmp1'),
    encodeVarint32(2),
    encodeVarint32(LOG_NUMBER),
  ]);
  writeFileSync(path.join(dir, 'MANIFEST-000001'), frameRecords(edit, 0));
  const entries = Object.entries(seed).map(([scriptKey, text]) => ({
    key: localStorageKey(scriptKey),
    value: Buffer.concat([Buffer.from([0x01]), Buffer.from(text, 'latin1')]),
  }));
  writeFileSync(
    logPath(store),
    entries.length > 0 ? frameRecords(encodeBatch(1n, entries), 0) : Buffer.alloc(0),
  );
}

/** One source card grouped as "Wanted", and the target's copy of it: groups work pending. */
function groupedStore(): StoreLayout {
  const store = makeStore();
  writeSession(store, OLD_ACCOUNT, session({ sessionId: 'local_src1', cliSessionId: 'conv-1' }));
  writeSession(store, NEW_ACCOUNT, session({ sessionId: 'local_tgt1', cliSessionId: 'conv-1' }));
  writeFileSync(
    store.desktopConfigFile,
    JSON.stringify({
      preferences: {
        epitaxyPrefs: {
          'dframe-group-scopes': {
            [scopeKey(OLD_ACCOUNT)]: {
              groups: [{ id: 'cg-src', name: 'Wanted' }],
              assignments: { [groupCardId('local_src1')]: 'cg-src' },
            },
          },
        },
      },
    }),
    'utf8',
  );
  return store;
}

/** A store with nothing for the layout to do but what a plugin asks. */
function quietStore(): StoreLayout {
  const store = makeStore();
  writeFileSync(store.desktopConfigFile, JSON.stringify({ preferences: {} }), 'utf8');
  return store;
}

function applyOpts(store: StoreLayout): Parameters<typeof applyLayout>[1] {
  return {
    store,
    ledger: new Ledger(path.join(store.root, 'ledger.jsonl')),
    list: () => [],
    env: { ...process.env, FOSTER_HOME: path.join(store.root, '.foster-home') },
    now: () => new Date(1_700_000_000_000),
  };
}

/** The keys of every batch in the Local Storage log, as text, in order. */
function batches(store: StoreLayout): string[][] {
  return readLog(readFileSync(logPath(store))).map((batch) =>
    decodeBatch(batch.payload).entries.map((entry) => {
      const key = entry.key.toString('latin1');
      return key.slice(key.indexOf('\x01') + 1);
    }),
  );
}

/** Asks for `text` in the plugin key until the store already holds it. */
function writesText(text: string): LayoutStorageWrite {
  return {
    name: 'example',
    writes: ({ store }) =>
      readLocalStorageText(store, PLUGIN_KEY) === text ? [] : [{ scriptKey: PLUGIN_KEY, text }],
  };
}

describe('registered Local Storage writes', () => {
  it('ride in the same batch and behind the same backup as the groups', () => {
    const store = groupedStore();
    makeDatabase(store);
    register(writesText('plain text, not JSON'));

    const result = applyLayout(planLayout({ store, target: NEW_ACCOUNT }), applyOpts(store));

    expect(readLocalStorageText(store, PLUGIN_KEY)).toBe('plain text, not JSON');
    expect(result.written).toEqual([
      'groups (config)',
      'groups (Local Storage)',
      'storage (registered)',
    ]);
    expect(result.storageWrites).toEqual([{ name: 'example', keys: 1 }]);
    const all = batches(store);
    expect(all).toHaveLength(1);
    expect(all[0]!.sort()).toEqual(
      ['LSS-persisted.dframe-group-scopes', 'dframe-store', PLUGIN_KEY].sort(),
    );
    expect(result.backups.filter((backup) => /localStorage/i.test(backup))).toHaveLength(1);
  });

  it('are their own batch, with one backup, when there are no groups to write', () => {
    const store = quietStore();
    makeDatabase(store);
    register(writesText('value'));

    const plan = planLayout({ store, target: NEW_ACCOUNT });
    expect(pendingLayoutCounts(plan).storageKeysWritten).toBe(1);
    const result = applyLayout(plan, applyOpts(store));

    expect(result.written).toEqual(['storage (registered)']);
    expect(batches(store)).toEqual([[PLUGIN_KEY]]);
    expect(result.backups).toHaveLength(1);
    expect(readLocalStorageText(store, PLUGIN_KEY)).toBe('value');
    // Once the store says it, nothing is pending any more.
    expect(
      totalLayoutPending(pendingLayoutCounts(planLayout({ store, target: NEW_ACCOUNT }))),
    ).toBe(0);
  });

  it('a write that throws stops the whole run before anything is written', () => {
    const store = groupedStore();
    makeDatabase(store);
    // Planned before the write is registered: the plan holds groups work, and
    // the registered write only fails when applyLayout asks it afresh.
    const plan = planLayout({ store, target: NEW_ACCOUNT });
    register({
      name: 'broken',
      writes: () => {
        throw new Error('cannot decide');
      },
    });
    const configBefore = readFileSync(store.desktopConfigFile);
    const logBefore = readFileSync(logPath(store));

    let thrown: unknown;
    try {
      applyLayout(plan, applyOpts(store));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LayoutWriteError);
    expect((thrown as LayoutWriteError).message).toMatch(/cannot decide/);
    expect((thrown as LayoutWriteError).written).toEqual([]);
    // Neither the groups' config copy nor the Local Storage log moved.
    expect(readFileSync(store.desktopConfigFile)).toEqual(configBefore);
    expect(readFileSync(logPath(store))).toEqual(logBefore);
  });

  it("refuses a key the layout writes itself, and writes nothing of the groups' either", () => {
    const store = groupedStore();
    makeDatabase(store);
    const plan = planLayout({ store, target: NEW_ACCOUNT });
    register({ name: 'greedy', writes: () => [{ scriptKey: 'dframe-store', text: '{}' }] });
    const configBefore = readFileSync(store.desktopConfigFile);

    expect(() => applyLayout(plan, applyOpts(store))).toThrow(/layout writes itself/);
    expect(readFileSync(store.desktopConfigFile)).toEqual(configBefore);
    expect(batches(store)).toEqual([]);
  });

  it('refuses two registrants claiming one key', () => {
    const store = quietStore();
    makeDatabase(store);
    register({ name: 'one', writes: () => [{ scriptKey: PLUGIN_KEY, text: 'a' }] });
    register({ name: 'two', writes: () => [{ scriptKey: PLUGIN_KEY, text: 'b' }] });

    expect(() => planLayout({ store, target: NEW_ACCOUNT })).toThrow(/both asked for/);
  });

  it('a dry run (planning alone) writes nothing', () => {
    const store = quietStore();
    makeDatabase(store, { [PLUGIN_KEY]: 'old' });
    register(writesText('new'));
    const logBefore = readFileSync(logPath(store));

    const plan = planLayout({ store, target: NEW_ACCOUNT });

    expect(plan.storageWrites).toEqual([{ name: 'example', scriptKeys: [PLUGIN_KEY] }]);
    expect(readFileSync(logPath(store))).toEqual(logBefore);
    expect(readLocalStorageText(store, PLUGIN_KEY)).toBe('old');
  });

  it('without a Local Storage database nothing is asked or pending', () => {
    const store = quietStore();
    let asked = 0;
    register({
      name: 'counting',
      writes: () => {
        asked += 1;
        return [{ scriptKey: PLUGIN_KEY, text: 'x' }];
      },
    });

    const plan = planLayout({ store, target: NEW_ACCOUNT });
    expect(plan.storageWrites).toBeUndefined();
    expect(applyLayout(plan, applyOpts(store)).written).toEqual([]);
    expect(asked).toBe(0);
  });

  it('with none registered, the plan and the run are what they were', () => {
    const store = groupedStore();
    makeDatabase(store);

    const plan = planLayout({ store, target: NEW_ACCOUNT });
    expect(plan).not.toHaveProperty('storageWrites');
    expect(pendingLayoutCounts(plan)).not.toHaveProperty('storageKeysWritten');
    const result = applyLayout(plan, applyOpts(store));
    expect(result.written).toEqual(['groups (config)', 'groups (Local Storage)']);
    expect(result).not.toHaveProperty('storageWrites');
  });
});
