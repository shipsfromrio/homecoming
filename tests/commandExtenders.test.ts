import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyCommandExtenders,
  registerCommandExtender,
  registerNextStepHint,
} from '../src/cli/commandExtenders.js';
import type { StoreLayout } from '../src/domain/types.js';
import type { Ledger } from '../src/ledger/log.js';
import { stripAnsi } from '../src/tui/widgets.js';

/**
 * Command extenders and next-step hints: a plugin adds options to a core
 * command, runs before it (or instead of it) and after it, and suggests what
 * to run next. Without either, the command runs exactly as defined.
 */

const store = { root: 'C:\\Store' } as StoreLayout;
const ledger = {} as Ledger;

let calls: string[];
let undo: (() => void)[];
let log: { mock: { calls: unknown[][] }; mockClear(): void; mockRestore(): void };

function program(): Command {
  const root = new Command().exitOverride();
  root
    .command('label')
    .argument('[name]')
    .option('--json', 'machine-readable output')
    .action((name: string | undefined) => {
      calls.push(`core:${name ?? ''}`);
    });
  const app = root.command('app');
  app.command('status').action(() => {
    calls.push('core:app status');
  });
  return root;
}

function apply(root: Command): () => void {
  const restore = applyCommandExtenders(
    root,
    () => ({ store, ledger }),
    () => {},
  );
  undo.push(restore);
  return restore;
}

function printed(): string[] {
  return log.mock.calls.map((call: unknown[]) => stripAnsi(String(call[0])));
}

beforeEach(() => {
  calls = [];
  undo = [];
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  for (const step of undo.reverse()) step();
  log.mockRestore();
});

describe('command extenders', () => {
  it("add their options to the command's --help", () => {
    undo.push(
      registerCommandExtender({
        command: 'label',
        options: [{ flags: '--forget', description: 'drop the name instead' }],
      }),
    );
    const root = program();
    apply(root);

    const label = root.commands.find((c) => c.name() === 'label')!;
    expect(label.helpInformation()).toContain('--forget');
    expect(label.helpInformation()).toContain('drop the name instead');
  });

  it('replace the core action when before returns true', async () => {
    undo.push(
      registerCommandExtender({
        command: 'label',
        options: [{ flags: '--forget', description: 'drop the name instead' }],
        before: (ctx) => {
          calls.push(`before:${String(ctx.options.forget)}`);
          return ctx.options.forget === true;
        },
      }),
    );
    const root = program();
    apply(root);

    await root.parseAsync(['label', 'x', '--forget'], { from: 'user' });
    await root.parseAsync(['label', 'y'], { from: 'user' });

    expect(calls).toEqual(['before:true', 'before:undefined', 'core:y']);
  });

  it('run after the action, with the parsed options, arguments, store and ledger', async () => {
    const seen: unknown[] = [];
    undo.push(
      registerCommandExtender({
        command: 'app status',
        options: [{ flags: '--depth <n>', description: 'how deep', defaultValue: '1' }],
        after: (ctx) => {
          calls.push('after');
          seen.push(ctx.options.depth, ctx.store, ctx.ledger, ctx.command.name());
        },
      }),
    );
    const root = program();
    apply(root);

    await root.parseAsync(['app', 'status', '--depth', '3'], { from: 'user' });

    expect(calls).toEqual(['core:app status', 'after']);
    expect(seen).toEqual(['3', store, ledger, 'status']);
  });

  it('refuse at apply time when the command does not exist, leaving nothing applied', () => {
    undo.push(
      registerCommandExtender({ command: 'label', options: [{ flags: '--a', description: 'a' }] }),
    );
    const off = registerCommandExtender({ command: 'nonexistent', before: () => true });
    const root = program();

    expect(() => apply(root)).toThrow(/nonexistent/);
    const label = root.commands.find((c) => c.name() === 'label')!;
    expect(label.helpInformation()).not.toContain('--a');
    off();
  });

  it('stop running once unregistered, and the restore takes their options away', async () => {
    const off = registerCommandExtender({
      command: 'label',
      options: [{ flags: '--forget', description: 'drop' }],
      before: () => {
        calls.push('before');
        return true;
      },
      after: () => {
        calls.push('after');
      },
    });
    const root = program();
    const restore = apply(root);

    off();
    await root.parseAsync(['label', 'z'], { from: 'user' });
    expect(calls).toEqual(['core:z']);

    restore();
    const label = root.commands.find((c) => c.name() === 'label')!;
    expect(label.helpInformation()).not.toContain('--forget');
  });

  it('leave the command untouched when none is registered', async () => {
    const root = program();
    apply(root);
    await root.parseAsync(['label', 'plain'], { from: 'user' });
    expect(calls).toEqual(['core:plain']);
    expect(printed()).toEqual([]);
  });
});

describe('command extenders and the store', () => {
  /** A command that answers for a missing store itself, the way `doctor --json` does. */
  function storeless(): Command {
    const root = new Command().exitOverride();
    root
      .command('doctor')
      .option('--json', 'machine-readable output')
      .action(() => {
        calls.push('core:doctor');
        console.log(JSON.stringify({ store: null, error: 'no store' }));
      });
    return root;
  }

  it('resolve the store only when a hook reads it', async () => {
    let resolved = 0;
    undo.push(
      registerCommandExtender({
        command: 'doctor',
        before: (ctx) => void calls.push(`before:${String(ctx.confirmed)}`),
      }),
    );
    const root = storeless();
    undo.push(
      applyCommandExtenders(
        root,
        () => {
          resolved += 1;
          throw new Error('no Claude Desktop store found');
        },
        () => {},
      ),
    );

    await root.parseAsync(['doctor', '--json'], { from: 'user' });
    expect(calls).toEqual(['before:true', 'core:doctor']);
    expect(printed()).toEqual(['{"store":null,"error":"no store"}']);
    expect(resolved).toBe(0);
  });

  it('resolve it once however often a hook reads it', async () => {
    let resolved = 0;
    undo.push(
      registerCommandExtender({
        command: 'label',
        before: (ctx) => void calls.push(ctx.store.root, ctx.store.root, String(ctx.ledger)),
      }),
    );
    const root = program();
    undo.push(
      applyCommandExtenders(
        root,
        () => {
          resolved += 1;
          return { store, ledger };
        },
        () => {},
      ),
    );
    await root.parseAsync(['label', 'a'], { from: 'user' });
    expect(resolved).toBe(1);
  });

  it('skip a hint that needs a store there is not, and keep the command', async () => {
    undo.push(registerNextStepHint({ command: 'doctor', text: ({ store: s }) => s.root }));
    const root = storeless();
    undo.push(
      applyCommandExtenders(
        root,
        () => {
          throw new Error('no store');
        },
        () => {},
      ),
    );
    await root.parseAsync(['doctor'], { from: 'user' });
    expect(calls).toEqual(['core:doctor']);
  });
});

describe('command extenders on a command that writes only when confirmed', () => {
  /** `purge` asks for --yes and --confirm, `return` for --yes; both dry-run otherwise. */
  function destructive(): Command {
    const root = new Command().exitOverride();
    root
      .command('purge')
      .option('--yes', 'actually destroy')
      .option('--confirm <count>', 'the number the dry run printed')
      .option('--dry-run', 'show what would happen')
      .action((opts: { yes?: boolean; confirm?: string }) => {
        calls.push(opts.yes && opts.confirm ? 'core:purge' : 'core:purge dry run');
      });
    root
      .command('return')
      .option('--yes', 'actually remove')
      .action((opts: { yes?: boolean }) => {
        calls.push(opts.yes ? 'core:return' : 'core:return dry run');
      });
    return root;
  }

  function standIn(command: string): void {
    undo.push(
      registerCommandExtender({
        command,
        before: (ctx) => {
          calls.push(`before:${String(ctx.confirmed)}`);
          return true;
        },
      }),
    );
  }

  it.each([
    [['purge'], ['before:false', 'core:purge dry run']],
    [
      ['purge', '--yes'],
      ['before:false', 'core:purge dry run'],
    ],
    [
      ['purge', '--confirm', '3'],
      ['before:false', 'core:purge dry run'],
    ],
    [['purge', '--yes', '--confirm', '3'], ['before:true']],
    [['return'], ['before:false', 'core:return dry run']],
    [
      ['return', '--dry-run'],
      ['before:false', 'core:return dry run'],
    ],
    [['return', '--yes'], ['before:true']],
  ])('%j: a before stands in only with the confirmation', async (argv, expected) => {
    standIn('purge');
    standIn('return');
    const root = destructive();
    root.commands.find((c) => c.name() === 'return')!.option('--dry-run', 'show');
    apply(root);
    await root.parseAsync(argv, { from: 'user' });
    expect(calls).toEqual(expected);
  });
});

describe('next-step hints', () => {
  it('print after the action, and stay silent under --json', async () => {
    undo.push(
      registerNextStepHint({
        command: 'label',
        text: ({ options }) => `next: run something (${String(options.json ?? false)})`,
      }),
    );
    undo.push(registerNextStepHint({ command: 'label', text: () => undefined }));
    const root = program();
    apply(root);

    await root.parseAsync(['label', 'a'], { from: 'user' });
    expect(calls).toEqual(['core:a']);
    expect(printed()).toEqual(['next: run something (false)']);

    log.mockClear();
    await root.parseAsync(['label', 'b', '--json'], { from: 'user' });
    expect(printed()).toEqual([]);
  });

  it('are gone once unregistered', async () => {
    const off = registerNextStepHint({ command: 'label', text: () => 'next' });
    const root = program();
    apply(root);
    off();

    await root.parseAsync(['label', 'a'], { from: 'user' });
    expect(printed()).toEqual([]);
  });
});
