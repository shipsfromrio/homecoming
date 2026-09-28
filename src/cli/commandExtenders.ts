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
  store: StoreLayout;
  ledger: Ledger;
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
 */
export interface CommandExtender {
  command: string;
  options?: readonly { flags: string; description: string; defaultValue?: unknown }[];
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
    for (const extender of extenders) {
      const command = targets.get(extender.command)!;
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
        const { store, ledger } = resolve(command);
        const options = command.optsWithGlobals<Record<string, unknown>>();
        const context: CommandExtenderContext = {
          command,
          args: holder.processedArgs ?? args,
          options,
          store,
          ledger,
          print,
        };
        const active = extenders.filter((extender) => extender.command === path);

        let handled = false;
        for (const extender of active) {
          if ((await extender.before?.(context)) === true) {
            handled = true;
            break;
          }
        }
        if (!handled) await original.call(command, args);
        for (const extender of active) await extender.after?.(context);

        if (options.json) return;
        for (const hint of hints.filter((item) => item.command === path)) {
          let text: string | undefined;
          try {
            text = hint.text({ options, store, ledger });
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
