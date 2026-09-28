import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { samePath } from '../src/domain/paths.js';
import {
  knownStores,
  registerStoreProvider,
  resolveStoreArg,
  type ProvidedStore,
} from '../src/engine/stores.js';
import { makeStore } from './helpers/store.js';

/**
 * A provider's `hint` and `remedy`: a line of explanation that reaches the
 * `KnownStore` as `note`, and what to do when the store is gone, which the
 * gone-store error carries. The core writes neither.
 */

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});
function provide(...entries: ProvidedStore[]): void {
  cleanups.push(registerStoreProvider(() => entries));
}

/** A path under a fresh temp directory that does not exist. */
function goneRoot(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'homecoming-gone-')), 'missing');
}

describe('provider notes and remedies', () => {
  it("the provider's hint reaches the known store as its note, and the remedy with it", () => {
    const store = makeStore();
    provide({ root: store.root, name: 'side', hint: 'a second profile', remedy: 'reinstall it' });

    const entry = knownStores([], {}).find((known) => samePath(known.root, store.root));
    expect(entry?.note).toBe('a second profile');
    expect(entry?.remedy).toBe('reinstall it');
    expect(entry?.hint).toBe('provided');
  });

  it('a gone store keeps its note and remedy', () => {
    const root = goneRoot();
    provide({ root, name: 'side', hint: 'a second profile', remedy: 'reinstall it' });

    const entry = knownStores([], {}).find((known) => known.name === 'side');
    expect(entry?.exists).toBe(false);
    expect(entry?.note).toBe('a second profile');
    expect(entry?.remedy).toBe('reinstall it');
  });

  it('the remedy is added to the error for a gone store', () => {
    provide({ root: goneRoot(), name: 'side', remedy: 'Run the setup again to recreate it.' });

    expect(() => resolveStoreArg('side', () => [], {})).toThrow(
      /which is gone\.\nRun the setup again to recreate it\./,
    );
  });

  it('without a remedy the error is exactly what it was', () => {
    const root = goneRoot();
    provide({ root, name: 'side' });

    let message = '';
    try {
      resolveStoreArg('side', () => [], {});
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(`store "side" is known at ${path.resolve(root)}, which is gone.`);
  });

  it('a provider that gives neither leaves both unset', () => {
    const store = makeStore();
    provide({ root: store.root });

    const entry = knownStores([], {}).find((known) => samePath(known.root, store.root));
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty('note');
    expect(entry).not.toHaveProperty('remedy');
  });
});
