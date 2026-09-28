import type { Command, Option } from 'commander';
import pc from 'picocolors';
import type { StoreLayout } from '../domain/types.js';
import type { Ledger } from '../ledger/log.js';
import { commandPath } from './commandPath.js';

/** Removes what a `register*` call added. */
type Unregister = () => void;

/** What a command extender's hooks see when the command runs. */
export interface CommandExtenderContext {
  command: Command;
  /** The command's parsed positional arguments. */
  args: readonly unknown[];
  /** Every option the command parsed, its own and the global ones, extenders' included. */
  options: Readonly<Record<string, unknown>>;
  /**
   * The store and ledger the command acts on, resolved on first read and not
   * before: a command that answers for a missing store on its own (`doctor
   * --json` prints `{ store: null, error }`) still does, unless a hook asks.
   * Reading either with no store throws the error the command would have.
   */
  readonly store: StoreLayout;
  readonly ledger: Ledger;
  /**
   * False on a run of a command that writes only when confirmed (one with a
   * `--yes` option, and `--confirm` too where it has one) that was not: its
   * dry run, which a `before` cannot stand in for.
   */
  confirmed: boolean;
  /** Prints a value as indented JSON, the way every `--json` output does. */
  print(value: unknown): void;
}

/**
 * Adds to a core command without replacing it: options of its own, a hook
 * before the command's action and one after it.
 *
 * `command` is the full command path (`label`, `app status`). A `before` that
 * returns `true` has handled the invocation itself, and the core action does
 * not run; anything else lets it run. `after` runs once the action (or the
 * `before` that stood in for it) finished without throwing.
 *
 * On a command that writes only when confirmed (`--yes`, and `--confirm` as
 * well where the command has it, as `purge` does), a `before` stands in only
 * when the run carries that same confirmation. Without it the `true` is not
 * obeyed and the core action runs, which on those commands is the dry run:
 * the confirmation a destructive command asks for is never skipped by a hook.
 */
export interface CommandExtender {
  command: string;
  options?: readonly { flags: string; description: string; defaultValue?: unknown }[];
  /**
   * The command's `--help` as the plugin changes what it does: a `summary`
   * (the one line in the command list) and a `description` (the text of its
   * own help), each replacing the core's while the extender is applied. A
   * plugin that widens a command says so where the user reads what it does,
   * and the core's text is left as it is for the build without the plugin.
   * Two extenders replacing the same one are refused.
   */
  help?: { summary?: string; description?: string };
  before?(context: CommandExtenderContext): boolean | void | Promise<boolean | void>;
  after?(context: CommandExtenderContext): void | Promise<void>;
}

/**
 * A line suggesting what to run next, printed dim after a command's action.
 * `text` returning nothing prints nothing, and no hint is ever printed on a
 * `--json` run, whose output must stay parseable.
 */
export interface NextStepHint {
  command: string;
  text(context: {
    options: Readonly<Record<string, unknown>>;
    store: StoreLayout;
    ledger: Ledger;
  }): string | undefined;
}

const extenders: CommandExtender[] = [];
const hints: NextStepHint[] = [];

function addTo<T>(list: T[], item: T): Unregister {
  list.push(item);
  return () => {
    const at = list.indexOf(item);
    if (at >= 0) list.splice(at, 1);
  };
}

/** Adds a command extender. Takes effect on the next `applyCommandExtenders`. */
export function registerCommandExtender(extender: CommandExtender): Unregister {
  return addTo(extenders, extender);
}

/** Adds a next-step hint. Takes effect on the next `applyCommandExtenders`. */
export function registerNextStepHint(hint: NextStepHint): Unregister {
  return addTo(hints, hint);
}

type ActionHandler = (args: unknown[]) => unknown;

/**
 * Commander keeps a command's action in a field it does not type. Reading and
 * replacing it is the only way to run something *instead of* the action, which
 * a `preAction` hook cannot do; a command without one is refused rather than
 * guessed at.
 */
interface WithAction {
  _actionHandler?: ActionHandler | null;
  processedArgs?: unknown[];
}

/** Whether the command's own options make it write only when confirmed. */
function confirmationOf(command: Command): { yes: boolean; confirm: boolean } {
  const longs = new Set(command.options.map((option) => option.long));
  return { yes: longs.has('--yes'), confirm: longs.has('--confirm') };
}

/**
 * Whether this run carries the confirmation its command asks for. A command
 * with neither option is always confirmed: there is nothing to skip.
 */
function isConfirmed(command: Command, options: Readonly<Record<string, unknown>>): boolean {
  const asks = confirmationOf(command);
  if (!asks.yes) return true;
  if (options.dryRun === true || options.yes !== true) return false;
  return !asks.confirm || (options.confirm !== undefined && options.confirm !== false);
}

function findCommand(root: Command, path: string): Command | undefined {
  for (const child of root.commands) {
    if (commandPath(child) === path) return child;
    const nested = findCommand(child, path);
    if (nested) return nested;
  }
  return undefined;
}

/**
 * Fits every registered extender and hint onto `program`: adds the extenders'
 * options to their commands and wraps each command's action so the hooks and
 * hints run around it. Hooks are looked up when the command runs, so one
 * unregistered after this call no longer runs; options stay until the
 * returned function undoes everything this call did.
 *
 * An extender or hint naming a command the program does not have is refused,
 * with nothing applied: a silent no-op would leave a plugin believing it had
 * extended something.
 */
export function applyCommandExtenders(
  program: Command,
  resolve: (command: Command) => { store: StoreLayout; ledger: Ledger },
  print: (value: unknown) => void,
): () => void {
  const targets = new Map<string, Command>();
  for (const path of new Set([...extenders, ...hints].map((item) => item.command))) {
    const command = findCommand(program, path);
    if (!command) throw new Error(`cannot extend "${path}": there is no such command`);
    if (typeof (command as unknown as WithAction)._actionHandler !== 'function') {
      throw new Error(`cannot extend "${path}": it has no action of its own`);
    }
    targets.set(path, command);
  }

  const undo: (() => void)[] = [];
  const restore = () => {
    for (const step of undo.reverse()) step();
    undo.length = 0;
  };

  try {
    const helpOwners = new Set<string>();
    for (const extender of extenders) {
      const command = targets.get(extender.command)!;
      for (const field of ['summary', 'description'] as const) {
        const text = extender.help?.[field];
        if (text === undefined) continue;
        const key = `${field}:${extender.command}`;
        if (helpOwners.has(key)) {
          throw new Error(`cannot extend "${extender.command}": its ${field} is replaced twice`);
        }
        helpOwners.add(key);
        const previous = command[field]();
        command[field](text);
        undo.push(() => {
          command[field](previous);
        });
      }
      for (const spec of extender.options ?? []) {
        const before = command.options.length;
        if (spec.defaultValue === undefined) command.option(spec.flags, spec.description);
        else command.option(spec.flags, spec.description, spec.defaultValue as string);
        const added = command.options.slice(before) as Option[];
        undo.push(() => {
          for (const option of added) {
            const at = command.options.indexOf(option);
            if (at >= 0) (command.options as Option[]).splice(at, 1);
            command.setOptionValue(option.attributeName(), undefined);
          }
        });
      }
    }

    for (const [path, command] of targets) {
      const holder = command as unknown as WithAction;
      const original = holder._actionHandler as ActionHandler;
      holder._actionHandler = async (args: unknown[]) => {
        const active = extenders.filter((extender) => extender.command === path);
        const pathHints = hints.filter((item) => item.command === path);
        // Nothing registered for this command any more: exactly the core
        // action, with the store resolved by it alone.
        if (active.length === 0 && pathHints.length === 0) {
          await original.call(command, args);
          return;
        }

        let resolved: { store: StoreLayout; ledger: Ledger } | undefined;
        const lazily = () => (resolved ??= resolve(command));
        const options = command.optsWithGlobals<Record<string, unknown>>();
        const confirmed = isConfirmed(command, options);
        const context: CommandExtenderContext = {
          command,
          args: holder.processedArgs ?? args,
          options,
          get store() {
            return lazily().store;
          },
          get ledger() {
            return lazily().ledger;
          },
          confirmed,
          print,
        };

        let handled = false;
        for (const extender of active) {
          if ((await extender.before?.(context)) === true) {
            handled = true;
            break;
          }
        }
        if (!handled || !confirmed) await original.call(command, args);
        for (const extender of active) await extender.after?.(context);

        if (options.json) return;
        for (const hint of pathHints) {
          let text: string | undefined;
          try {
            text = hint.text({ options, store: context.store, ledger: context.ledger });
          } catch {
            text = undefined;
          }
          if (text) console.log(pc.dim(text));
        }
      };
      undo.push(() => {
        holder._actionHandler = original;
      });
    }
  } catch (error) {
    restore();
    throw error;
  }

  return restore;
}
