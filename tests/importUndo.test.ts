import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StoreLayout } from '../src/domain/types.js';
import { Ledger } from '../src/ledger/log.js';
import {
  registerImportUndoProvider,
  runImportUndo,
  type ImportUndoProvider,
} from '../src/ops/importUndo.js';
import { makeStore } from './helpers/store.js';

/**
 * Import undo providers: something other than fostering brought files into a
 * store, and the plugin that did it lists and removes them. The core has none
 * and does nothing.
 */

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

/** A provider owning files named `imported-*.txt` at the store root. */
function fileProvider(names: string[]): ImportUndoProvider {
  return {
    name: 'files',
    select: ({ store }) =>
      names
        .filter((name) => existsSync(path.join(store.root, name)))
        .map((name) => ({ id: name, line: name })),
    undo: (id, { store, dryRun }) => {
      const file = path.join(store.root, id);
      if (!dryRun) rmSync(file);
      return { ok: true, line: `${dryRun ? 'would remove' : 'removed'} ${id}` };
    },
  };
}

function setup(): { store: StoreLayout; ledger: Ledger; names: string[] } {
  const store = makeStore();
  const names = ['imported-a.txt', 'imported-b.txt'];
  for (const name of names) writeFileSync(path.join(store.root, name), 'x', 'utf8');
  return { store, ledger: new Ledger(path.join(store.root, 'ledger.jsonl')), names };
}

describe('import undo', () => {
  it('with no provider, does nothing', () => {
    const { store, ledger } = setup();
    expect(runImportUndo({ store, ledger, dryRun: false })).toEqual({
      lines: [],
      undone: 0,
      failed: 0,
    });
  });

  it('lists and undoes what a provider selects', () => {
    const { store, ledger, names } = setup();
    cleanups.push(registerImportUndoProvider(fileProvider(names)));

    const result = runImportUndo({ store, ledger, dryRun: false });
    expect(result).toEqual({
      lines: ['removed imported-a.txt', 'removed imported-b.txt'],
      undone: 2,
      failed: 0,
    });
    for (const name of names) expect(existsSync(path.join(store.root, name))).toBe(false);
  });

  it('a dry run changes nothing', () => {
    const { store, ledger, names } = setup();
    cleanups.push(registerImportUndoProvider(fileProvider(names)));

    const result = runImportUndo({ store, ledger, dryRun: true });
    expect(result.lines).toEqual(['would remove imported-a.txt', 'would remove imported-b.txt']);
    for (const name of names) expect(existsSync(path.join(store.root, name))).toBe(true);
  });

  it('passes the options through to select', () => {
    const { store, ledger } = setup();
    let seen: Readonly<Record<string, unknown>> = {};
    cleanups.push(
      registerImportUndoProvider({
        name: 'options',
        select: ({ options }) => {
          seen = options;
          return [];
        },
        undo: () => ({ ok: true, line: '' }),
      }),
    );

    runImportUndo({ store, ledger, dryRun: true, options: { only: 'recent' } });
    expect(seen).toEqual({ only: 'recent' });
  });

  it('counts failures, and one failing provider does not stop the next', () => {
    const { store, ledger, names } = setup();
    cleanups.push(
      registerImportUndoProvider({
        name: 'broken-select',
        select: () => {
          throw new Error('cannot list');
        },
        undo: () => ({ ok: true, line: '' }),
      }),
    );
    cleanups.push(
      registerImportUndoProvider({
        name: 'mixed',
        select: () => [
          { id: 'one', line: 'one' },
          { id: 'two', line: 'two' },
          { id: 'three', line: 'three' },
        ],
        undo: (id) => {
          if (id === 'two') return { ok: false, line: 'two: still in use' };
          if (id === 'three') throw new Error('disk said no');
          return { ok: true, line: 'one: undone' };
        },
      }),
    );
    cleanups.push(registerImportUndoProvider(fileProvider(names)));

    const result = runImportUndo({ store, ledger, dryRun: false });
    expect(result.undone).toBe(3);
    expect(result.failed).toBe(3);
    expect(result.lines).toEqual([
      'broken-select: could not list what to undo: cannot list',
      'one: undone',
      'two: still in use',
      'mixed: three: failed: disk said no',
      'removed imported-a.txt',
      'removed imported-b.txt',
    ]);
  });
});
