import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { definePlugin, type HomecomingPlugin } from '../src/plugin.js';
import { runCli } from '../src/cli/index.js';
import { Ledger } from '../src/ledger/log.js';
import type * as Safety from '../src/engine/safety.js';
import { makeStore, NEW_ACCOUNT } from './helpers/store.js';

// `doctor` asks whether Claude Desktop is running, and the real probe answers
// for whatever runs on the test machine.
vi.mock('../src/engine/safety.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Safety>();
  return {
    ...actual,
    inspectApp: () => ({ running: false, evidence: [] }),
    assertRemovable: () => {},
  };
});

/**
 * The extension points a plugin fills, driven end to end through `runCli`: a
 * registry that works when called directly and is never consulted by the
 * command it was meant for is the failure this guards against. Each case also
 * runs the same command with no plugin, to pin that the core alone behaves as
 * it did before the point existed.
 */

function ledgerPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'homecoming-plugin-cli-')), 'l.jsonl');
}

/** A store whose config says `NEW_ACCOUNT` is signed in, and a ledger of its own. */
function signedIn(): { global: string[]; ledger: string; root: string } {
  const store = makeStore();
  writeFileSync(
    store.configFile,
    JSON.stringify({ lastKnownAccountUuid: NEW_ACCOUNT.accountUuid }),
    'utf8',
  );
  const ledger = ledgerPath();
  return {
    global: ['--no-cache', '--store', store.root, '--ledger', ledger],
    ledger,
    root: store.root,
  };
}

interface Run {
  out: string[];
  err: string[];
  exitCode: number | undefined;
}

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.restoreAllMocks();
});

/**
 * One `runCli`, with console output captured and the exit code it set given
 * back and then cleared. Commander's own refusals (an unknown option, a value
 * outside `.choices`) end in `process.exit`, which is turned into a throw that
 * `runCli` reports like any other error.
 */
async function run(plugins: HomecomingPlugin[], argv: string[]): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    err.push(args.map(String).join(' '));
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as never);
  const before = process.exitCode;
  process.exitCode = undefined;
  try {
    dispose = await runCli({ plugins, argv });
    return { out, err, exitCode: process.exitCode };
  } finally {
    process.exitCode = before;
    vi.restoreAllMocks();
  }
}

function lastJson<T>(result: Run): T {
  return JSON.parse(result.out.at(-1) ?? 'null') as T;
}

describe('whoami --json, with identity readers and sources', () => {
  const SEEN_AT = 1_800_000_000_000;
  const remembering = definePlugin({
    name: 'remembering',
    identitySources: [
      (accountUuid) =>
        accountUuid === NEW_ACCOUNT.accountUuid
          ? { email: 'someone@example.com', name: 'Someone', seenAt: SEEN_AT }
          : undefined,
    ],
  });
  const reading = definePlugin({
    name: 'reading',
    identityReaders: [
      (_store, accountUuid) => (accountUuid === NEW_ACCOUNT.accountUuid ? { plan: 'basic' } : {}),
    ],
  });

  it('without a plugin, has the fields and nothing in them', async () => {
    const { global } = signedIn();
    const result = await run([], [...global, 'whoami', '--json']);
    expect(lastJson(result)).toEqual({
      accountUuid: NEW_ACCOUNT.accountUuid,
      email: null,
      name: null,
      plan: null,
      remembered: false,
      seenAt: null,
    });
  });

  it('answers from a source when the cache is empty, and says it is remembered', async () => {
    const { global } = signedIn();
    const result = await run([remembering], [...global, 'whoami', '--json']);
    expect(lastJson(result)).toEqual({
      accountUuid: NEW_ACCOUNT.accountUuid,
      email: 'someone@example.com',
      name: 'Someone',
      plan: null,
      remembered: true,
      seenAt: SEEN_AT,
    });
  });

  it('takes the plan from a reader, which makes the read fresh', async () => {
    const { global } = signedIn();
    const result = await run([remembering, reading], [...global, 'whoami', '--json']);
    expect(lastJson(result)).toEqual({
      accountUuid: NEW_ACCOUNT.accountUuid,
      email: 'someone@example.com',
      name: 'Someone',
      plan: 'basic',
      remembered: false,
      seenAt: null,
    });
  });

  it('tells an identity observer what the fresh read found', async () => {
    const { global } = signedIn();
    const seen: unknown[] = [];
    const observing = definePlugin({
      name: 'observing',
      identityObservers: [
        {
          name: 'watch',
          onIdentitySeen: (accountUuid, identity) => seen.push([accountUuid, identity]),
        },
      ],
    });
    await run([reading, observing], [...global, 'whoami', '--json']);
    expect(seen).toEqual([[NEW_ACCOUNT.accountUuid, { plan: 'basic' }]]);
  });

  it('lets `label --from-cache` name the account from what a source remembers', async () => {
    const { global, ledger } = signedIn();
    const without = await run([], [...global, 'label', '--from-cache']);
    expect(without.exitCode).toBe(1);

    const result = await run([remembering], [...global, 'label', '--from-cache']);
    expect(result.exitCode).toBeUndefined();
    expect(new Ledger(ledger).read()).toContainEqual(
      expect.objectContaining({ kind: 'account_labelled', accountUuid: NEW_ACCOUNT.accountUuid }),
    );
  });
});

describe('a command extender on `label`', () => {
  const forgetting = (calls: string[]) =>
    definePlugin({
      name: 'forgetting',
      commandExtenders: [
        {
          command: 'label',
          options: [{ flags: '--forget', description: 'drop what was remembered' }],
          before: ({ options, print }) => {
            if (!options.forget) return false;
            calls.push('before');
            print({ forgotten: true });
            return true;
          },
          after: () => {
            calls.push('after');
          },
        },
      ],
    });

  it('is an unknown option without the plugin', async () => {
    const { global } = signedIn();
    const result = await run([], [...global, 'label', '--forget']);
    expect(result.exitCode).toBe(1);
    expect(result.err.join('\n')).toMatch(/unknown option '--forget'/);
  });

  it('runs instead of the core action when its `before` says it handled the call', async () => {
    const { global, ledger } = signedIn();
    const calls: string[] = [];
    const result = await run([forgetting(calls)], [...global, 'label', '--forget']);
    expect(result.exitCode).toBeUndefined();
    expect(lastJson(result)).toEqual({ forgotten: true });
    expect(calls).toEqual(['before', 'after']);
    // The core `label` with no argument would have named the signed-in account.
    expect(new Ledger(ledger).read()).toEqual([]);
  });

  it('leaves the core action alone when its option is not given', async () => {
    const { global, ledger } = signedIn();
    const calls: string[] = [];
    const result = await run([forgetting(calls)], [...global, 'label', 'a name']);
    expect(result.exitCode).toBeUndefined();
    expect(calls).toEqual(['after']);
    expect(new Ledger(ledger).read()).toContainEqual(
      expect.objectContaining({ kind: 'account_labelled', label: 'a name' }),
    );
  });

  it('fails the run, and runs nothing, when it names a command that does not exist', async () => {
    const { global, ledger } = signedIn();
    const lost = definePlugin({
      name: 'lost',
      commandExtenders: [{ command: 'no-such-command', before: () => true }],
    });
    const result = await run([lost], [...global, 'label', 'a name']);
    expect(result.exitCode).toBe(1);
    expect(result.err.join('\n')).toMatch(/no-such-command/);
    expect(new Ledger(ledger).read()).toEqual([]);
  });
});

describe('a next-step hint', () => {
  const hinting = definePlugin({
    name: 'hinting',
    nextStepHints: [
      { command: 'labels', text: () => 'Next: try the example command.' },
      { command: 'stores', text: () => 'Next: try the example command.' },
    ],
  });

  it('is printed after `labels`, and only with the plugin', async () => {
    const { global } = signedIn();
    expect((await run([], [...global, 'labels'])).out.join('\n')).not.toContain('Next:');
    const result = await run([hinting], [...global, 'labels']);
    expect(result.out.at(-1)).toContain('Next: try the example command.');
  });

  it('is never printed on a --json run', async () => {
    const { global } = signedIn();
    const result = await run([hinting], [...global, 'stores', '--json']);
    expect(result.out.join('\n')).not.toContain('Next:');
    expect(() => lastJson(result)).not.toThrow();
  });
});

describe('stats --by and a stats dimension', () => {
  const grouping = definePlugin({
    name: 'grouping',
    statsDimensions: [{ name: 'example', keyOf: () => 'everything' }],
    statsCounters: [{ name: 'examples', count: () => 1 }],
  });

  it('refuses a dimension nobody registered', async () => {
    const { global } = signedIn();
    const result = await run([], [...global, 'stats', '--by', 'example', '--json']);
    expect(result.exitCode).toBe(1);
    expect(result.err.join('\n')).toMatch(/example/);
  });

  it("accepts the plugin's dimension, and lets go of it once unregistered", async () => {
    const { global } = signedIn();
    const result = await run([grouping], [...global, 'stats', '--by', 'example', '--json']);
    expect(result.exitCode).toBeUndefined();
    expect(lastJson<{ by: string }>(result).by).toBe('example');

    dispose?.();
    dispose = undefined;
    const after = await run([], [...global, 'stats', '--by', 'example', '--json']);
    expect(after.exitCode).toBe(1);
  });

  it('still accepts the core dimensions with a plugin registered', async () => {
    const { global } = signedIn();
    for (const by of ['model', 'week']) {
      const result = await run([grouping], [...global, 'stats', '--by', by, '--json']);
      expect(result.exitCode).toBeUndefined();
      expect(lastJson<{ by: string }>(result).by).toBe(by);
    }
  });
});

describe('doctor --json and a check with top-level keys', () => {
  const keyed = definePlugin({
    name: 'keyed',
    doctorChecks: [
      {
        name: 'Keyed',
        run: () => [{ level: 'ok', message: 'fine', data: { detail: 1 } }],
        json: () => ({ exampleState: 'armed', version: 'not yours' }),
      },
    ],
  });

  it("adds the check's keys beside the core's, and refuses one the core owns", async () => {
    const { global } = signedIn();
    const plain = lastJson<Record<string, unknown>>(await run([], [...global, 'doctor', '--json']));
    expect(plain).not.toHaveProperty('exampleState');

    const json = lastJson<{
      version: unknown;
      exampleState?: unknown;
      checks: { name: string; findings: { level: string; message: string; data?: unknown }[] }[];
    }>(await run([keyed], [...global, 'doctor', '--json']));
    expect(json.exampleState).toBe('armed');
    expect(json.version).toBe(plain.version);
    expect(Object.keys(json).slice(0, Object.keys(plain).length)).toEqual(Object.keys(plain));
    const findings = json.checks.find((check) => check.name === 'Keyed')?.findings ?? [];
    expect(findings[0]).toEqual({ level: 'ok', message: 'fine', data: { detail: 1 } });
    expect(
      findings.some((finding) => finding.level === 'warn' && /version/.test(finding.message)),
    ).toBe(true);
  });
});

describe('stores and a provider note', () => {
  it('prints the note a provider attached, and nothing extra without one', async () => {
    const { global, root } = signedIn();
    const noted = definePlugin({
      name: 'noted',
      storeProviders: [() => [{ root, name: 'noted-store', hint: 'kept by the example plugin' }]],
    });
    const bare = definePlugin({
      name: 'bare',
      storeProviders: [() => [{ root, name: 'bare-store' }]],
    });

    const withNote = (await run([noted], [...global, 'stores'])).out.join('\n');
    expect(withNote).toMatch(/noted-store .*kept by the example plugin/);

    const without = (await run([bare], [...global, 'stores'])).out.find((line) =>
      line.includes('bare-store'),
    );
    expect(without).toBeDefined();
    expect(without).not.toContain(' — ');
  });
});

describe('return and an import undo provider', () => {
  const undone: { id: string; dryRun: boolean }[] = [];
  const importing = definePlugin({
    name: 'importing',
    importUndoProviders: [
      {
        name: 'example-imports',
        select: () => [{ id: 'import-1', line: 'example import 1' }],
        undo: (id, { dryRun }) => {
          undone.push({ id, dryRun });
          return { ok: true, line: `${dryRun ? 'would undo' : 'undid'} ${id}` };
        },
      },
    ],
  });

  it('says nothing is fostered without the plugin', async () => {
    const { global } = signedIn();
    expect((await run([], [...global, 'return'])).out).toContain('Nothing is fostered.');
  });

  it("lists the provider's imports on the dry run and undoes them with --yes", async () => {
    const { global } = signedIn();
    undone.length = 0;
    const dry = await run([importing], [...global, 'return']);
    expect(dry.out).not.toContain('Nothing is fostered.');
    expect(dry.out.join('\n')).toContain('import-1');
    expect(dry.out.join('\n')).toMatch(/Dry run: 1 would be returned/);

    const real = await run([importing], [...global, 'return', '--yes']);
    expect(real.out.join('\n')).toMatch(/1 returned, 0 failed/);
    expect(undone.at(-1)).toEqual({ id: 'import-1', dryRun: false });
  });
});
