import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { samePath } from '../src/domain/paths.js';
import type { StoreLayout } from '../src/domain/types.js';
import {
  registerStoreArgResolver,
  registerStoreProvider,
  resolveStoreArg,
  type KnownStore,
  type StoreArgResolver,
} from '../src/engine/stores.js';
import { makeStore } from './helpers/store.js';

/**
 * `--store` resolvers: a plugin adds a meaning for the argument (an e-mail
 * address, say), consulted after every meaning the core owns except the
 * path-piece pass. It can add a meaning, never change one.
 */

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function provide(...entries: { root: string; name?: string }[]): void {
  cleanups.push(registerStoreProvider(() => entries));
}
function resolveWith(resolver: StoreArgResolver): void {
  cleanups.push(registerStoreArgResolver(resolver));
}

const noEvents = () => [];

/** Two provided stores, and a distinctive piece of the first one's path. */
function twoStores(): { first: StoreLayout; second: StoreLayout; piece: string } {
  const first = makeStore();
  const second = makeStore();
  provide({ root: first.root }, { root: second.root });
  return { first, second, piece: path.basename(first.root) };
}

describe('--store resolvers', () => {
  it('without a resolver, a path piece resolves as before', () => {
    const { first, piece } = twoStores();
    expect(samePath(resolveStoreArg(piece, noEvents, {}).root, first.root)).toBe(true);
  });

  it('a resolver answers before the path-piece pass', () => {
    const { second, piece } = twoStores();
    resolveWith((arg, { stores }) => {
      if (arg !== piece) return undefined;
      const found = stores.find((store) => samePath(store.root, second.root));
      return found ? { ...second } : undefined;
    });

    expect(samePath(resolveStoreArg(piece, noEvents, {}).root, second.root)).toBe(true);
  });

  it('finds a store by an address no core meaning knows', () => {
    const { second } = twoStores();
    resolveWith((arg) => (arg === 'person@example.test' ? second : undefined));

    expect(samePath(resolveStoreArg('person@example.test', noEvents, {}).root, second.root)).toBe(
      true,
    );
  });

  it('an existing path still wins', () => {
    const { first, second } = twoStores();
    resolveWith(() => second);

    expect(samePath(resolveStoreArg(first.root, noEvents, {}).root, first.root)).toBe(true);
  });

  it("a provider's name still wins", () => {
    const named = makeStore();
    const other = makeStore();
    provide({ root: named.root, name: 'work' });
    resolveWith(() => other);

    expect(samePath(resolveStoreArg('work', noEvents, {}).root, named.root)).toBe(true);
  });

  it('receives the known stores', () => {
    twoStores();
    let seen: readonly KnownStore[] = [];
    resolveWith((_arg, context) => {
      seen = context.stores;
      return undefined;
    });

    expect(() => resolveStoreArg('no-such-thing-anywhere', noEvents, {})).toThrow();
    expect(seen.length).toBe(2);
  });

  it('a resolver that throws does not replace the "not a directory" error', () => {
    twoStores();
    resolveWith(() => {
      throw new Error('resolver broke');
    });

    let message = '';
    try {
      resolveStoreArg('no-such-thing-anywhere', noEvents, {});
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/is not a directory/);
    expect(message).toMatch(/resolver broke/);
  });

  it('a resolver that throws does not stop the path-piece pass', () => {
    const { first, piece } = twoStores();
    resolveWith(() => {
      throw new Error('resolver broke');
    });

    expect(samePath(resolveStoreArg(piece, noEvents, {}).root, first.root)).toBe(true);
  });

  it('unregistering takes the meaning away', () => {
    const { second } = twoStores();
    const undo = registerStoreArgResolver((arg) =>
      arg === 'person@example.test' ? second : undefined,
    );
    undo();

    expect(() => resolveStoreArg('person@example.test', noEvents, {})).toThrow(
      /is not a directory/,
    );
  });
});
