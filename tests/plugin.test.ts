import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { definePlugin, usePlugin } from '../src/plugin.js';
import { runCli } from '../src/cli/index.js';
import { runDoctorChecks, runSweepPhases, listMenuItems } from '../src/extensions.js';
import { projectSlot } from '../src/ledger/extensions.js';
import { Ledger } from '../src/ledger/log.js';
import { findStopped } from '../src/engine/revive.js';
import { knownStores } from '../src/engine/stores.js';
import { configDirCandidates } from '../src/store/configDirs.js';
import { refuseGuarded } from '../src/store/appPrefs.js';
import { labelsOf } from '../src/cli/names.js';
import { menuCommands } from '../src/tui/slash.js';
import type { DiscoveredSession } from '../src/domain/types.js';
import type { SweepReport } from '../src/ops/sweep.js';
import type * as Safety from '../src/engine/safety.js';
import { scanAccount } from '../src/store/scanner.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

// `homecoming sweep --yes` asks whether Claude Desktop is running before it
// writes, and the real probe answers for whatever runs on the test machine.
vi.mock('../src/engine/safety.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Safety>();
  return {
    ...actual,
    inspectApp: () => ({ running: false, evidence: [] }),
    assertRemovable: () => {},
  };
});

/**
 * The contract a plugin relies on: every extension point a `HomecomingPlugin`
 * can fill is consulted by the core, and unregistering takes each one away
 * again. A plugin that registers and then finds its field ignored is the
 * failure this guards against.
 */

function ledger(): Ledger {
  return new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'homecoming-plugin-')), 'l.jsonl'));
}

const store = makeStore();
const extraConfigDir = path.join(tmpdir(), 'homecoming-plugin-config-dir');

const example = definePlugin({
  name: 'example',
  register(program, context) {
    program
      .command('example-hello')
      .description('say hello from a plugin')
      .action(function () {
        context.print({ hello: 'plugin', path: context.commandPath(this) });
      });
  },
  ledgerReducers: [
    {
      slot: 'example',
      kinds: ['example.counted'],
      initial: () => 0,
      reduce: (count: unknown) => (count as number) + 1,
    },
  ],
  storeProviders: [() => [{ root: store.root, name: 'example-store' }]],
  configDirProviders: [() => [extraConfigDir]],
  accountNamers: [() => new Map([[NEW_ACCOUNT.accountUuid, 'named by example']])],
  sweepPhases: [
    {
      name: 'example-phase',
      run: ({ dryRun }) => ({ lines: [`example phase, dry run: ${dryRun}`], json: { ran: true } }),
    },
  ],
  doctorChecks: [{ name: 'Example', run: () => [{ level: 'ok', message: 'all good' }] }],
  menuItems: [
    {
      value: 'example-menu',
      slash: 'example',
      label: 'Example entry',
      run: () => Promise.resolve(),
    },
  ],
  reviveInclusions: [{ name: 'example-copies', includeCopy: () => true }],
  appPrefAllowlists: [{ name: 'example-prefs', keys: ['coworkHipaaRestricted'] }],
  credentialProbes: [
    { name: 'example-token', hasTokenCache: (candidate) => candidate.root === store.root },
  ],
});

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.restoreAllMocks();
});

describe('a registered plugin', () => {
  it('folds its own event kinds into its own slot, and the core fold ignores them', () => {
    dispose = usePlugin(example);
    const log = ledger();
    log.appendRecord({ kind: 'example.counted' });
    log.appendRecord({ kind: 'example.counted' });
    log.appendRecord({ kind: 'someone.else' });

    expect(projectSlot<number>(log, 'example')).toBe(2);
    expect(log.read()).toEqual([]);
  });

  it('offers its stores, config directories and account names to the core', () => {
    dispose = usePlugin(example);

    const found = knownStores([], {});
    expect(found.map((known) => known.name)).toContain('example-store');
    expect(found.find((known) => known.name === 'example-store')?.hasTokenCache).toBe(true);
    expect(configDirCandidates({}, [], tmpdir())).toContain(extraConfigDir);
    expect(labelsOf(ledger()).get(NEW_ACCOUNT.accountUuid)).toBe('named by example');
  });

  it('consults its revive inclusion and preference allowlist, and drops both when unregistered', () => {
    const data = session({
      sessionId: '00000000-0000-4000-8000-0000000000c1',
      title: 'Copy',
    });
    const copy = {
      account: NEW_ACCOUNT,
      path: 'x.json',
      data,
      isCopy: true,
      isStranded: false,
      reasons: [],
    } satisfies DiscoveredSession;
    const answers = {
      filesOf: (id: string) => (id === data.cliSessionId ? [id] : []),
      lastAnswer: () => ({ at: 1_800_000_000_000, error: 'rate_limit' as const, text: 'limit' }),
      liveIds: new Set<string>(),
    };
    const selection = { since: 0, includeArchived: false };

    dispose = usePlugin(example);
    expect(findStopped([copy], selection, answers).stopped).toHaveLength(1);
    expect(() => refuseGuarded(['coworkHipaaRestricted'])).not.toThrow();
    expect(() => refuseGuarded(['orgWorkAcrossAppsDisabled'])).toThrow(/refusing to write/);

    dispose();
    dispose = undefined;
    const after = findStopped([copy], selection, answers);
    expect(after.stopped).toEqual([]);
    expect(after.passedOver[0]?.reason).toBe('other-account');
    expect(() => refuseGuarded(['coworkHipaaRestricted'])).toThrow(/refusing to write/);
  });

  it('runs its sweep phase, doctor check and menu item', async () => {
    dispose = usePlugin(example);

    const phases = await runSweepPhases({
      store,
      ledger: ledger(),
      target: NEW_ACCOUNT,
      dryRun: true,
      report: {} as SweepReport,
      options: {},
    });
    expect(phases).toEqual([
      {
        name: 'example-phase',
        result: { lines: ['example phase, dry run: true'], json: { ran: true } },
      },
    ]);
    expect(runDoctorChecks({ store, ledger: ledger() })).toEqual([
      { name: 'Example', findings: [{ level: 'ok', message: 'all good' }] },
    ]);
    const menu = menuCommands().map((command) => command.value);
    expect(menu).toContain('example-menu');
    expect(menu.indexOf('example-menu')).toBeLessThan(menu.indexOf('app'));
  });

  it('is gone from every extension point once unregistered', async () => {
    usePlugin(example)();

    expect(knownStores([], {})).toEqual([]);
    expect(configDirCandidates({}, [], tmpdir())).not.toContain(extraConfigDir);
    expect(labelsOf(ledger()).get(NEW_ACCOUNT.accountUuid)).toBeUndefined();
    expect(listMenuItems()).toEqual([]);
    expect(runDoctorChecks({ store, ledger: ledger() })).toEqual([]);
    expect(
      await runSweepPhases({
        store,
        ledger: ledger(),
        target: NEW_ACCOUNT,
        dryRun: true,
        report: {} as SweepReport,
        options: {},
      }),
    ).toEqual([]);
    expect(() => projectSlot(ledger(), 'example')).toThrow(/no ledger reducer/);
  });

  it('refuses a reducer that claims a core kind, and registers nothing of that plugin', () => {
    const greedy = definePlugin({
      name: 'greedy',
      menuItems: [{ value: 'greedy', slash: 'greedy', label: 'x', run: () => Promise.resolve() }],
      ledgerReducers: [{ slot: 'greedy', kinds: ['fostered'], initial: () => 0, reduce: (s) => s }],
    });
    expect(() => usePlugin(greedy)).toThrow(/claims core kind/);
    expect(listMenuItems()).toEqual([]);
  });

  it('keeps a menu item from shadowing a core entry', () => {
    dispose = usePlugin(
      definePlugin({
        name: 'shadow',
        menuItems: [{ value: 'sweep', slash: 'sweep', label: 'x', run: () => Promise.resolve() }],
      }),
    );
    expect(menuCommands().filter((command) => command.value === 'sweep')).toHaveLength(1);
  });

  it('adds a command the CLI runs', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    dispose = await runCli({ plugins: [example], argv: ['example-hello'] });
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ hello: 'plugin', path: 'example-hello' }, null, 2),
    );
  });
});

describe('a plugin sweep phase, run by the `homecoming sweep` command', () => {
  // `runSweepPhases` called directly (above) proves the registry; this proves
  // the command consults it: on the dry run, into `--json` under
  // `phases.<name>`, and after the writes of a `--yes` run, printed.
  it('runs on the dry run and after the writes, with its lines and its JSON', async () => {
    const swept = makeStore();
    writeSession(
      swept,
      NEW_ACCOUNT,
      session({ sessionId: '11111111-1111-4111-8111-11111111bbbb' }),
    );
    writeSession(
      swept,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000b1', title: 'Bring me' }),
    );
    writeFileSync(
      swept.configFile,
      JSON.stringify({ lastKnownAccountUuid: NEW_ACCOUNT.accountUuid }),
      'utf8',
    );
    const ledgerPath = path.join(
      mkdtempSync(path.join(tmpdir(), 'homecoming-plugin-l-')),
      'l.jsonl',
    );
    const calls: boolean[] = [];
    const phased = definePlugin({
      name: 'phased',
      sweepPhases: [
        {
          name: 'phased',
          run: ({ dryRun }) => {
            calls.push(dryRun);
            return { lines: [`phased ran, dry run: ${dryRun}`], json: { dryRun } };
          },
        },
      ],
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const before = process.exitCode;
    const global = ['--no-cache', '--store', swept.root, '--ledger', ledgerPath];
    try {
      dispose = await runCli({ plugins: [phased], argv: [...global, 'sweep', '--json'] });
      dispose();
      const json = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
        phases?: Record<string, unknown>;
      };
      expect(json.phases).toEqual({ phased: { dryRun: true } });
      expect(scanAccount(swept, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(0);

      log.mockClear();
      dispose = await runCli({ plugins: [phased], argv: [...global, 'sweep', '--yes'] });
      const printed = log.mock.calls.map((call) => String(call[0]));
      expect(printed).toContain('phased ran, dry run: false');
      expect(scanAccount(swept, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(1);
      expect(calls).toEqual([true, false]);
      expect(process.exitCode ?? 0).toBe(before ?? 0);
    } finally {
      process.exitCode = before;
    }
  });
});

describe('runCli and a plugin that fails to register', () => {
  const broken = (where: 'usePlugin' | 'register') =>
    definePlugin({
      name: `broken-${where}`,
      ...(where === 'usePlugin'
        ? {
            ledgerReducers: [
              { slot: 'broken', kinds: ['fostered'], initial: () => 0, reduce: (s: unknown) => s },
            ],
          }
        : {
            register() {
              throw new Error('register blew up');
            },
          }),
    });

  it.each(['usePlugin', 'register'] as const)(
    'prints the error and sets exit code 1 when %s throws, instead of throwing',
    async (where) => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const before = process.exitCode;
      try {
        await expect(
          runCli({ plugins: [broken(where)], argv: ['--version'] }).then((undo) => {
            dispose = undo;
          }),
        ).resolves.toBeUndefined();
        expect(process.exitCode).toBe(1);
        expect(errors.mock.calls.flat().join('\n')).toContain(`plugin "broken-${where}"`);
      } finally {
        process.exitCode = before;
      }
    },
  );

  it('takes back what earlier plugins registered, and runs no command', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const before = process.exitCode;
    try {
      const fine = definePlugin({
        name: 'fine',
        menuItems: [{ value: 'fine', slash: 'fine', label: 'x', run: () => Promise.resolve() }],
      });
      dispose = await runCli({ plugins: [fine, broken('register')], argv: ['doctor'] });
      expect(listMenuItems()).toEqual([]);
      expect(log).not.toHaveBeenCalled();
    } finally {
      process.exitCode = before;
    }
  });
});
