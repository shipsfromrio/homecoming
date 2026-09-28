import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { definePlugin, usePlugin } from '../src/plugin.js';
import { runCli } from '../src/cli/index.js';
import { projectSlot } from '../src/ledger/extensions.js';
import { Ledger } from '../src/ledger/log.js';
import { findStopped } from '../src/engine/revive.js';
import { configDirCandidates } from '../src/store/configDirs.js';
import { labelsOf } from '../src/cli/names.js';
import { menuCommands } from '../src/tui/slash.js';
import type { DiscoveredSession } from '../src/domain/types.js';
import type { SweepReport } from '../src/ops/sweep.js';
import type * as Safety from '../src/engine/safety.js';
import { scanAccount } from '../src/store/scanner.js';
import { candidateStoreRoots } from '../src/domain/paths.js';
import { knownStores, resolveStoreArg } from '../src/engine/stores.js';
import { statsDimensionNames, usageEventsInFile } from '../src/engine/stats.js';
import { listAgentTools } from '../src/agentTools.js';
import {
  listAccountMenuItems,
  listMenuItems,
  runDoctorChecks,
  runSweepPhases,
} from '../src/extensions.js';
import { runImportUndo } from '../src/ops/importUndo.js';
import { refuseGuarded } from '../src/store/appPrefs.js';
import type { AccountOverview } from '../src/store/accounts.js';
import { identityOf } from '../src/store/identity.js';
import { decorateAccount } from '../src/cli/accountDecorators.js';
import { applyCommandExtenders } from '../src/cli/commandExtenders.js';
import { FOSTER_NIGHT, themeColor } from '../src/tui/theme.js';
import { updateRepo } from '../src/update.js';
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

/**
 * The points added after 1.0.0, one plugin carrying every one of them. Each is
 * asked the way the core asks it, and asked again after unregistering, when it
 * must be gone. The command-level wiring (whoami, stats --by, doctor --json,
 * stores, return, label) is driven end to end in `tests/pluginCli.test.ts`.
 */
describe('the extension points a plugin can fill beyond commands and state', () => {
  const account = NEW_ACCOUNT.accountUuid;
  const candidate = makeStore();
  const resolved = makeStore();
  const asked: string[] = [];
  const seen: string[] = [];

  const wide = definePlugin({
    name: 'wide',
    storeRootCandidates: [() => [{ root: candidate.root, priority: 1 }]],
    storeArgResolvers: [(arg) => (arg === 'by-resolver' ? resolved : undefined)],
    identityReaders: [(_store, uuid) => (uuid === account ? { name: 'Someone' } : undefined)],
    identitySources: [
      (uuid) => (uuid === account ? { email: 'someone@example.com', seenAt: 1 } : undefined),
    ],
    identityObservers: [{ name: 'wide', onIdentitySeen: (uuid) => void seen.push(uuid) }],
    accountDecorators: [() => ({ marker: '+', meta: ['example'] })],
    accountMenuItems: [
      { value: 'wide-action', label: 'Wide action', run: () => Promise.resolve() },
    ],
    commandExtenders: [{ command: 'greet', before: () => void asked.push('extender') }],
    nextStepHints: [{ command: 'greet', text: () => 'wide hint' }],
    statsDimensions: [{ name: 'wide', keyOf: () => 'all' }],
    statsCounters: [{ name: 'wide', count: () => 1 }],
    importUndoProviders: [
      {
        name: 'wide',
        select: () => [{ id: 'one', line: 'one import' }],
        undo: (id) => ({ ok: true, line: `undid ${id}` }),
      },
    ],
    updateChannel: { repo: 'example-owner/example-repo' },
    themeSlots: [{ name: 'wide', night: '#112233', day: '#445566' }],
    agentTools: [
      {
        name: 'wide',
        description: 'an example tool',
        inputSchema: { type: 'object' },
        run: () => Promise.resolve(null),
      },
    ],
  });

  /** A tiny program with one command, for the extenders and hints to fit onto. */
  async function greet(): Promise<string[]> {
    const program = new Command();
    program.exitOverride();
    program.command('greet').action(() => void asked.push('greet'));
    const printed: string[] = [];
    const log = vi
      .spyOn(console, 'log')
      .mockImplementation((line: unknown) => void printed.push(String(line)));
    const undo = applyCommandExtenders(
      program,
      () => ({ store, ledger: ledger() }),
      () => {},
    );
    try {
      await program.parseAsync(['greet'], { from: 'user' });
    } finally {
      undo();
      log.mockRestore();
    }
    return printed;
  }

  /** Every point asked once, in one place, so registered and unregistered compare. */
  async function consult() {
    asked.length = 0;
    seen.length = 0;
    const signedIn = makeStore();
    writeFileSync(signedIn.configFile, JSON.stringify({ lastKnownAccountUuid: account }), 'utf8');
    const transcript = path.join(
      mkdtempSync(path.join(tmpdir(), 'homecoming-plugin-t-')),
      't.jsonl',
    );
    writeFileSync(
      transcript,
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(1_800_000_000_000).toISOString(),
        message: { model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 1 } },
      }),
      'utf8',
    );
    const printed = await greet();
    let storeArg: string | undefined;
    try {
      storeArg = resolveStoreArg('by-resolver', () => [], {}).root;
    } catch {
      storeArg = undefined;
    }
    return {
      defaultStores: candidateStoreRoots({}),
      storeArg,
      identity: identityOf(signedIn, account, ledger()),
      observed: [...seen],
      decoration: decorateAccount({} as AccountOverview, { store, ledger: ledger() }),
      accountMenu: listAccountMenuItems().map((item) => item.value),
      greet: [...asked],
      hint: printed.some((line) => line.includes('wide hint')),
      dimensions: statsDimensionNames(),
      counters: usageEventsInFile(transcript, 0)[0]?.counters,
      imports: runImportUndo({ store, ledger: ledger(), dryRun: true }).lines,
      updateRepo: updateRepo({}),
      themeSlot: themeColor(FOSTER_NIGHT, 'wide'),
      agentTools: listAgentTools().map((tool) => tool.name),
    };
  }

  it('consults every one of them while registered', async () => {
    dispose = usePlugin(wide);
    const got = await consult();

    expect(got.defaultStores[0]).toBe(candidate.root);
    expect(got.storeArg).toBe(resolved.root);
    expect(got.identity).toEqual({ email: 'someone@example.com', name: 'Someone' });
    expect(got.observed).toEqual([account]);
    expect(got.decoration).toMatchObject({ marker: '+', meta: ['example'] });
    expect(got.accountMenu).toContain('wide-action');
    expect(got.greet).toEqual(['extender', 'greet']);
    expect(got.hint).toBe(true);
    expect(got.dimensions).toEqual(['model', 'week', 'wide']);
    expect(got.counters).toEqual({ wide: 1 });
    expect(got.imports).toEqual(['undid one']);
    expect(got.updateRepo).toBe('example-owner/example-repo');
    expect(got.themeSlot).toBe('#112233');
    expect(got.agentTools).toEqual(['wide']);
  });

  it('lets go of every one of them once unregistered', async () => {
    usePlugin(wide)();
    const got = await consult();

    expect(got.defaultStores).not.toContain(candidate.root);
    expect(got.storeArg).toBeUndefined();
    expect(got.identity).toBeUndefined();
    expect(got.observed).toEqual([]);
    expect(got.decoration).toBeUndefined();
    expect(got.accountMenu).toEqual([]);
    expect(got.greet).toEqual(['greet']);
    expect(got.hint).toBe(false);
    expect(got.dimensions).toEqual(['model', 'week']);
    expect(got.counters).toBeUndefined();
    expect(got.imports).toEqual([]);
    expect(got.updateRepo).not.toBe('example-owner/example-repo');
    expect(got.themeSlot).toBeUndefined();
    expect(got.agentTools).toEqual([]);
  });

  it('refuses a second update channel, and takes back what that plugin registered first', () => {
    dispose = usePlugin(definePlugin({ name: 'first', updateChannel: { repo: 'first/channel' } }));
    const second = definePlugin({
      name: 'second',
      statsDimensions: [{ name: 'second', keyOf: () => 'x' }],
      accountMenuItems: [{ value: 'second', label: 'x', run: () => Promise.resolve() }],
      identitySources: [() => ({ email: 'second@example.com', seenAt: 1 })],
      updateChannel: { repo: 'second/channel' },
    });

    expect(() => usePlugin(second)).toThrow(/plugin "second" could not be registered/);
    expect(statsDimensionNames()).toEqual(['model', 'week']);
    expect(listAccountMenuItems()).toEqual([]);
    expect(identityOf(makeStore(), account, ledger())).toBeUndefined();
    expect(updateRepo({})).toBe('first/channel');
  });
});
