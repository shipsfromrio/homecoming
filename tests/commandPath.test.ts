import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { commandPath } from '../src/cli/commandPath.js';

/**
 * `commandPath` is what a plugin's hook gets (`PluginContext.commandPath`) to
 * tell one command from another. `command.name()` alone answers only the leaf,
 * so `homecoming app status` and the top-level `homecoming status` would look
 * the same: both leaves are named `status`.
 */
describe('commandPath', () => {
  function program(): Command {
    const program = new Command('homecoming');
    program.command('status');
    program.command('sweep');
    const app = program.command('app');
    app.command('status');
    const view = program.command('view');
    view.command('set');
    return program;
  }

  it('names a top-level command by itself', () => {
    const cli = program();
    expect(commandPath(cli.commands.find((c) => c.name() === 'status')!)).toBe('status');
    expect(commandPath(cli.commands.find((c) => c.name() === 'sweep')!)).toBe('sweep');
  });

  it('prefixes a subcommand with its parent, so it never collides with an unrelated top-level name', () => {
    const cli = program();
    const app = cli.commands.find((c) => c.name() === 'app')!;
    const appStatus = app.commands.find((c) => c.name() === 'status')!;
    expect(commandPath(appStatus)).toBe('app status');
    expect(commandPath(appStatus)).not.toBe(
      commandPath(cli.commands.find((c) => c.name() === 'status')!),
    );
  });

  it('walks more than one level', () => {
    const cli = program();
    const view = cli.commands.find((c) => c.name() === 'view')!;
    const set = view.commands.find((c) => c.name() === 'set')!;
    expect(commandPath(set)).toBe('view set');
  });
});
