import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CORE_STORE_ROOT_PRIORITY,
  candidateStoreRoots,
  registerStoreRootCandidates,
  resolveStore,
  samePath,
  type StoreRootCandidateSource,
} from '../src/domain/paths.js';
import { knownStores } from '../src/engine/stores.js';
import { makeInstalledStore, makeStore } from './helpers/store.js';

/**
 * Store root candidates: a plugin adds places an installation may keep its
 * userData, and the merged, prioritised list is what `resolveStore`, `stores`
 * and the desktop inspection all read. Without one registered the list is the
 * core's, unchanged.
 */

const cleanups: (() => void)[] = [];
function offer(source: StoreRootCandidateSource): void {
  cleanups.push(registerStoreRootCandidates(source));
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe('store root candidates', () => {
  it('without a source, lists only the core candidates', () => {
    const { store, env } = makeInstalledStore();
    const roots = candidateStoreRoots(env);
    expect(roots).toHaveLength(1);
    expect(samePath(roots[0]!, store.root)).toBe(true);
  });

  it('a candidate below the core priority becomes the store resolveStore picks', () => {
    const { store: installed, env } = makeInstalledStore();
    const extra = makeStore();
    offer(() => [{ root: extra.root, priority: CORE_STORE_ROOT_PRIORITY - 50 }]);

    expect(samePath(resolveStore(undefined, env).root, extra.root)).toBe(true);
    const roots = candidateStoreRoots(env);
    expect(roots.map((root) => samePath(root, extra.root))).toEqual([true, false]);
    expect(samePath(roots[1]!, installed.root)).toBe(true);
  });

  it('a candidate above the core priority is known but not the default', () => {
    const { store: installed, env } = makeInstalledStore();
    const extra = makeStore();
    offer(() => [{ root: extra.root, priority: CORE_STORE_ROOT_PRIORITY + 1 }]);

    expect(samePath(resolveStore(undefined, env).root, installed.root)).toBe(true);
    const known = knownStores([], env);
    expect(known.some((entry) => samePath(entry.root, extra.root))).toBe(true);
  });

  it('drops a candidate that holds no Code sessions, whoever offered it', () => {
    const { env } = makeInstalledStore();
    const empty = mkdtempSync(path.join(tmpdir(), 'homecoming-no-sessions-'));
    offer(() => [{ root: empty, priority: 0 }]);

    expect(candidateStoreRoots(env).some((root) => samePath(root, empty))).toBe(false);
  });

  it('an explicit --store still wins over every candidate', () => {
    const { env } = makeInstalledStore();
    const extra = makeStore();
    const explicit = makeStore();
    offer(() => [{ root: extra.root, priority: 0 }]);

    expect(samePath(resolveStore(explicit.root, env).root, explicit.root)).toBe(true);
  });

  it('passes the environment to the source', () => {
    const extra = makeStore();
    offer((env) => (env.SOME_DATA_DIR ? [{ root: env.SOME_DATA_DIR, priority: 0 }] : []));

    expect(candidateStoreRoots({})).toEqual([]);
    expect(candidateStoreRoots({ SOME_DATA_DIR: extra.root })).toEqual([extra.root]);
  });

  it('lists a root offered twice once, at its best place', () => {
    const { store: installed, env } = makeInstalledStore();
    offer(() => [{ root: installed.root, priority: 500 }]);

    expect(candidateStoreRoots(env)).toHaveLength(1);
  });

  it('unregistering gives back the core order', () => {
    const { store: installed, env } = makeInstalledStore();
    const extra = makeStore();
    const undo = registerStoreRootCandidates(() => [{ root: extra.root, priority: 0 }]);
    expect(samePath(resolveStore(undefined, env).root, extra.root)).toBe(true);

    undo();
    const roots = candidateStoreRoots(env);
    expect(roots).toHaveLength(1);
    expect(samePath(roots[0]!, installed.root)).toBe(true);
  });
});
