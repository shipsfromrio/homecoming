import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Safety from '../src/engine/safety.js';
import { Ledger } from '../src/ledger/log.js';
import type { AccountRef, StoreLayout } from '../src/domain/types.js';
import {
  registerAccountMenuItem,
  registerMenuItem,
  type MenuContext,
  type Unregister,
} from '../src/extensions.js';
import { accountActions, filterCommands, menuAliases, COMMAND_ALIASES } from '../src/tui/slash.js';
import type { DashboardAccount } from '../src/tui/ui.js';
import { ScriptedUi } from './helpers/scripted.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

// Same doubles as the guided-menu suite: nothing here may look at, close or
// launch the Claude Desktop running on the machine that runs the tests.
vi.mock('../src/engine/safety.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Safety>();
  return {
    ...actual,
    inspectApp: () => ({ running: false, evidence: [] }),
    assertRemovable: () => {},
  };
});

vi.mock('../src/engine/desktop.js', () => ({
  inspectDesktop: () => ({ running: false, codeSessions: 0, selfHosted: false }),
  inspectDesktopFor: () => ({ running: false, codeSessions: 0, selfHosted: false }),
  quitDesktop: () => Promise.resolve({ outcome: 'not-running' }),
  startDesktop: () => Promise.resolve(true),
  packagedAppId: () => undefined,
  runningStores: () => [],
  readProcesses: () => [],
  hostedByDesktop: () => false,
  DesktopControlError: class extends Error {},
}));

const { runInteractive } = await import('../src/cli/interactive.js');

let undo: Unregister[] = [];
let store: StoreLayout;
let ledger: Ledger;

function signedInStore(account: AccountRef): StoreLayout {
  const made = makeStore();
  writeSession(made, account, session({ sessionId: '22222222-2222-4222-8222-22222222aaaa' }));
  writeFileSync(
    made.configFile,
    JSON.stringify({ lastKnownAccountUuid: account.accountUuid }),
    'utf8',
  );
  return made;
}

async function play(answers: unknown[]): Promise<ScriptedUi> {
  const ui = new ScriptedUi(answers);
  await runInteractive(store, ledger, ui);
  return ui;
}

function row(overrides: Partial<DashboardAccount> = {}): DashboardAccount {
  return {
    accountUuid: OLD_ACCOUNT.accountUuid,
    shortId: '00000000',
    isCurrent: false,
    sessions: 2,
    copies: 0,
    ...overrides,
  };
}

beforeEach(() => {
  store = signedInStore(NEW_ACCOUNT);
  writeSession(store, OLD_ACCOUNT, session({ sessionId: '00000000-0000-4000-8000-0000000000a1' }));
  ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'hc-menu-')), 'l.jsonl'));
});

afterEach(() => {
  for (const step of undo.reverse()) step();
  undo = [];
});

describe('menu item aliases', () => {
  it('leads a registered alias to its item, first in the palette', () => {
    expect(filterCommands('neat').some((command) => command.value === 'tidy')).toBe(false);
    undo.push(
      registerMenuItem({
        value: 'tidy',
        slash: 'tidy',
        label: 'Tidy up',
        aliases: ['neat', '/Clean'],
        run: () => Promise.resolve(),
      }),
    );
    expect(filterCommands('neat')[0]?.value).toBe('tidy');
    expect(filterCommands('/clean')[0]?.value).toBe('tidy');
  });

  it('ignores an alias that is a core alias, value or slash', () => {
    undo.push(
      registerMenuItem({
        value: 'tidy',
        slash: 'tidy',
        label: 'Tidy up',
        aliases: ['all', 'quit', 'exit', 'status'],
        run: () => Promise.resolve(),
      }),
    );
    const table = menuAliases();
    expect(table.all).toBe('sweep');
    expect(table.exit).toBe('quit');
    expect(table.quit).toBeUndefined();
    expect(table.status).toBeUndefined();
    expect(filterCommands('all')[0]?.value).toBe('sweep');
    expect(filterCommands('exit')[0]?.value).toBe('quit');
  });

  it('brings no aliases for an item left out of the menu, and none without plugins', () => {
    expect(menuAliases()).toBe(COMMAND_ALIASES);
    undo.push(
      registerMenuItem({
        value: 'sweep',
        slash: 'shadow',
        label: 'Shadow',
        aliases: ['shade'],
        run: () => Promise.resolve(),
      }),
    );
    expect(menuAliases().shade).toBeUndefined();
  });
});

describe('account menu items', () => {
  it('is offered only when `when` says so, with its label computed per row', () => {
    const plain = accountActions(row()).map((choice) => choice.value);
    undo.push(
      registerAccountMenuItem({
        value: 'peek',
        label: (account) => `Peek at ${account.shortId}`,
        hint: 'a look',
        when: (account) => !account.isCurrent,
        run: () => Promise.resolve(),
      }),
    );
    const other = accountActions(row());
    expect(other.map((choice) => choice.value)).toEqual([...plain, 'peek']);
    expect(other.at(-1)).toEqual({ value: 'peek', label: 'Peek at 00000000', hint: 'a look' });
    expect(accountActions(row({ isCurrent: true })).map((choice) => choice.value)).not.toContain(
      'peek',
    );
  });

  it('ignores a value that is a core verb or a menu command', () => {
    for (const value of ['label', 'details', 'foster-from', 'sweep']) {
      undo.push(
        registerAccountMenuItem({ value, label: `stolen ${value}`, run: () => Promise.resolve() }),
      );
    }
    const labels = accountActions(row()).map((choice) => choice.label);
    expect(labels.some((label) => label.startsWith('stolen'))).toBe(false);
  });

  it('runs with the account under the cursor, and a clashing value never reaches the item', async () => {
    const seen: Array<{ uuid: string; target: string }> = [];
    let stolen = 0;
    undo.push(
      registerAccountMenuItem({
        value: 'peek',
        label: 'Peek',
        run: (context, accountUuid) => {
          seen.push({ uuid: accountUuid, target: context.target.accountUuid });
          return Promise.resolve();
        },
      }),
      registerAccountMenuItem({
        value: 'details',
        label: 'stolen',
        run: () => {
          stolen += 1;
          return Promise.resolve();
        },
      }),
    );
    await play([`peek:${OLD_ACCOUNT.accountUuid}`, `details:${OLD_ACCOUNT.accountUuid}`, 'quit']);
    expect(seen).toEqual([{ uuid: OLD_ACCOUNT.accountUuid, target: NEW_ACCOUNT.accountUuid }]);
    expect(stolen).toBe(0);
  });

  it('does nothing for an unregistered verb, as before', async () => {
    const ui = await play([`peek:${OLD_ACCOUNT.accountUuid}`, 'quit']);
    expect(ui.errors).toEqual([]);
  });
});

describe('moving the menu to another store', () => {
  function recorder(seen: string[]): Unregister {
    return registerMenuItem({
      value: 'where',
      slash: 'where',
      label: 'Where am I',
      run: (context: MenuContext) => {
        seen.push(`${context.store.root}|${context.target.accountUuid}`);
        return Promise.resolve();
      },
    });
  }

  it('acts on the returned store, and its signed-in account, from the next screen on', async () => {
    const other = signedInStore(OLD_ACCOUNT);
    const seen: string[] = [];
    undo.push(
      recorder(seen),
      registerMenuItem({
        value: 'hop',
        slash: 'hop',
        label: 'Hop',
        run: () => Promise.resolve({ store: other }),
      }),
    );
    await play(['where', 'hop', 'where', 'quit']);
    // Reusing the store the loop opened with would print the first line twice.
    expect(seen).toEqual([
      `${store.root}|${NEW_ACCOUNT.accountUuid}`,
      `${other.root}|${OLD_ACCOUNT.accountUuid}`,
    ]);
  });

  it('honours switchStore with an explicit target', async () => {
    const other = signedInStore(OLD_ACCOUNT);
    const seen: string[] = [];
    undo.push(
      recorder(seen),
      registerMenuItem({
        value: 'hop',
        slash: 'hop',
        label: 'Hop',
        run: (context) => {
          context.switchStore?.(other, NEW_ACCOUNT);
          return Promise.resolve();
        },
      }),
    );
    await play(['hop', 'where', 'quit']);
    expect(seen).toEqual([`${other.root}|${NEW_ACCOUNT.accountUuid}`]);
  });

  it('stays put, and says so, when nobody is signed in to the new store', async () => {
    const empty = makeStore();
    const seen: string[] = [];
    undo.push(
      recorder(seen),
      registerMenuItem({
        value: 'hop',
        slash: 'hop',
        label: 'Hop',
        run: () => Promise.resolve({ store: empty }),
      }),
    );
    const ui = await play(['hop', 'where', 'quit']);
    expect(seen).toEqual([`${store.root}|${NEW_ACCOUNT.accountUuid}`]);
    expect(ui.errors.some((line) => line.includes(empty.root))).toBe(true);
  });
});
