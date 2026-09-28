import type { AccountRef, StoreLayout } from './domain/types.js';
import type { Ledger } from './ledger/log.js';
import type { SweepReport } from './ops/sweep.js';
import type { DashboardAccount, Ui } from './tui/ui.js';

/**
 * The extension points the core consults at run time, beyond the ones that live
 * beside the code they extend (store providers in `engine/stores.ts`, config
 * directory providers in `store/configDirs.ts`, account namers in
 * `cli/names.ts`, ledger reducers in `ledger/extensions.ts`, revive inclusions
 * in `engine/revive.ts`, preference allowlists in `store/appPrefs.ts`,
 * credential probes in `store/config.ts`).
 *
 * Every registry here is a plain list with an unregister function, so a test
 * can add an extension and take it away again, and nothing is global beyond the
 * lifetime of one process. `plugin.ts` is the one place that fills all of them
 * from a single `HomecomingPlugin`.
 */

/** Removes what a `register*` call added. */
export type Unregister = () => void;

function registry<T>(): { items: T[]; add(item: T): Unregister } {
  const items: T[] = [];
  return {
    items,
    add(item: T): Unregister {
      items.push(item);
      return () => {
        const at = items.indexOf(item);
        if (at >= 0) items.splice(at, 1);
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Sweep phases

export interface PostSweepContext {
  store: StoreLayout;
  ledger: Ledger;
  target: AccountRef;
  dryRun: boolean;
  /** What the core passes did, already complete. */
  report: SweepReport;
  /** Every option the `sweep` command parsed, including any a plugin added to it. */
  options: Readonly<Record<string, unknown>>;
}

/**
 * What a phase hands back. Printing and counting are separate on purpose:
 * `lines` is only what to show, and says nothing about whether there was work.
 * The interactive menu decides "Nothing to sweep" and whether to offer a
 * restart from `pending` and `changed` alone, so a phase that always reports
 * something ("nothing to do here", a count of zero) does not keep the menu from
 * ever saying there is nothing to sweep, and does not trigger a restart offer
 * on every run. A phase with real work has to say so in those two fields.
 */
export interface PostSweepResult {
  /**
   * Lines printed after the core summary. Shown, never counted: returning
   * lines does not by itself mean the phase has work or made a change.
   */
  lines?: string[];
  /**
   * On a dry run: how many writes this phase would make on the real run. Above
   * zero, the menu shows its plan instead of "Nothing to sweep". Leave it out
   * (or zero) when there is nothing to do.
   */
  pending?: number;
  /**
   * On a real run: how many writes this phase made. Above zero, the menu treats
   * the sweep as having changed something and offers the restart that shows it.
   */
  changed?: number;
  /** Merged into `sweep --json` under `phases.<name>`. */
  json?: unknown;
  /**
   * Also writes `json` at the top of `sweep --json`, under this key, for a
   * build whose scripts already read it there. A key the core itself writes
   * (`fostered`, `prove`, `restart`, `phases`, ...) is never taken, even on a run
   * where the core leaves it out, and the first phase to name a key keeps it: a
   * later one is reported on stderr. Either way the phase's JSON is still under
   * `phases.<name>`.
   */
  jsonKey?: string;
  /** Failed writes; any above zero makes a `--yes` run exit 1. */
  failed?: number;
}

/**
 * A pass that runs after the core sweep passes, in registration order. It sees
 * the finished report and returns what to print, what to add to the JSON, and
 * how many writes failed. Returning nothing means it had nothing to do.
 */
export interface PostSweepPhase {
  name: string;
  /**
   * Options the interactive menu's sweep passes to every phase, where the
   * `sweep` command would pass the ones it parsed. The menu has no command
   * line, so without this a phase that reads an option always saw `{}` there.
   * The menu passes the union of every phase's declaration, in registration
   * order (a later phase wins a key both declare). A function is called once
   * per sweep; one that throws contributes nothing.
   */
  interactiveOptions?:
    | Readonly<Record<string, unknown>>
    | ((context: {
        store: StoreLayout;
        ledger: Ledger;
        target: AccountRef;
      }) => Readonly<Record<string, unknown>>);
  run(
    context: PostSweepContext,
  ): PostSweepResult | undefined | Promise<PostSweepResult | undefined>;
}

const sweepPhases = registry<PostSweepPhase>();

export function registerSweepPhase(phase: PostSweepPhase): Unregister {
  return sweepPhases.add(phase);
}

/**
 * What the interactive sweep passes as `options`: the union of every phase's
 * `interactiveOptions`. Empty when no phase declares any, which is what the
 * menu passed before phases could declare them.
 */
export function sweepPhaseInteractiveOptions(context: {
  store: StoreLayout;
  ledger: Ledger;
  target: AccountRef;
}): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  for (const phase of sweepPhases.items) {
    const declared = phase.interactiveOptions;
    if (declared === undefined) continue;
    let value: Readonly<Record<string, unknown>> | undefined;
    try {
      value = typeof declared === 'function' ? declared(context) : declared;
    } catch {
      // The phase still runs and can report the missing option itself; one bad
      // declaration must not cost the other phases theirs.
      continue;
    }
    if (value && typeof value === 'object') Object.assign(options, value);
  }
  return options;
}

/** One phase's outcome, as `runSweepPhases` returns it. */
export interface SweepPhaseOutcome {
  name: string;
  result?: PostSweepResult;
  error?: string;
}

function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Writes the phases declared they would make, from a dry run's outcomes. */
export function pendingPhaseWork(outcomes: readonly SweepPhaseOutcome[]): number {
  return outcomes.reduce((sum, outcome) => sum + countOf(outcome.result?.pending), 0);
}

/** Writes the phases declared they made, from a real run's outcomes. */
export function changedByPhases(outcomes: readonly SweepPhaseOutcome[]): number {
  return outcomes.reduce((sum, outcome) => sum + countOf(outcome.result?.changed), 0);
}

/** Runs every registered phase in order; one that throws is reported, not fatal. */
export async function runSweepPhases(context: PostSweepContext): Promise<SweepPhaseOutcome[]> {
  const outcomes: SweepPhaseOutcome[] = [];
  for (const phase of sweepPhases.items) {
    try {
      const result = await phase.run(context);
      outcomes.push(result ? { name: phase.name, result } : { name: phase.name });
    } catch (error) {
      outcomes.push({
        name: phase.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// Doctor checks

export interface DoctorFinding {
  level: 'ok' | 'info' | 'warn' | 'error';
  message: string;
  /** Structured detail, carried as is into `doctor --json` under the check. */
  data?: Readonly<Record<string, unknown>>;
}

/** One more thing `doctor` looks at. Read-only by contract: a check never writes. */
export interface DoctorCheck {
  name: string;
  run(context: { store: StoreLayout; ledger: Ledger }): DoctorFinding[];
  /**
   * Keys this check adds at the top level of `doctor --json`, beside the core
   * ones. A key the core already prints, or one an earlier check claimed, is
   * refused rather than allowed to overwrite it.
   */
  json?(context: { store: StoreLayout; ledger: Ledger }): Readonly<Record<string, unknown>>;
}

const doctorChecks = registry<DoctorCheck>();

export function registerDoctorCheck(check: DoctorCheck): Unregister {
  return doctorChecks.add(check);
}

/** Every registered check's findings; a check that throws becomes an `error` finding. */
export function runDoctorChecks(context: {
  store: StoreLayout;
  ledger: Ledger;
}): { name: string; findings: DoctorFinding[] }[] {
  return doctorChecks.items.map((check) => {
    try {
      return { name: check.name, findings: check.run(context) };
    } catch (error) {
      return {
        name: check.name,
        findings: [
          { level: 'error', message: error instanceof Error ? error.message : String(error) },
        ],
      };
    }
  });
}

/**
 * The top-level keys the registered checks add to `doctor --json`, merged in
 * registration order. A key in `reservedKeys` (the core's own) or one an
 * earlier check already claimed is refused. A `json` that throws adds nothing.
 *
 * When `results` (what `runDoctorChecks` returned) is passed, a refusal becomes
 * a `warn` finding and a throw an `error` finding under that check, so neither
 * is silent; without it they are only left out.
 */
export function doctorTopLevelJson(
  context: { store: StoreLayout; ledger: Ledger },
  reservedKeys: readonly string[],
  results?: { name: string; findings: DoctorFinding[] }[],
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const taken = new Set(reservedKeys);
  const report = (name: string, finding: DoctorFinding): void => {
    if (!results) return;
    let entry = results.find((result) => result.name === name);
    if (!entry) {
      entry = { name, findings: [] };
      results.push(entry);
    }
    entry.findings.push(finding);
  };
  for (const check of doctorChecks.items) {
    if (!check.json) continue;
    let value: Readonly<Record<string, unknown>>;
    try {
      value = check.json(context);
    } catch (error) {
      report(check.name, {
        level: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    for (const [key, entry] of Object.entries(value)) {
      if (taken.has(key)) {
        report(check.name, {
          level: 'warn',
          message: `JSON key "${key}" is already taken; left out`,
        });
        continue;
      }
      taken.add(key);
      merged[key] = entry;
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Menu items

export interface MenuContext {
  ui: Ui;
  store: StoreLayout;
  ledger: Ledger;
  target: AccountRef;
  /**
   * Asks the menu to act on another store (and, optionally, another target)
   * from the next screen on. The same as returning `{ store, target }` from
   * `run`; a returned outcome wins when an item does both.
   */
  switchStore?(store: StoreLayout, target?: AccountRef): void;
}

/**
 * What a menu item may hand back. With `store`, the menu acts on that store from
 * the next screen on; with `target`, on that account. A `store` without a
 * `target` means the account signed in to that store. Returning nothing keeps
 * both as they were.
 */
export interface MenuOutcome {
  store?: StoreLayout;
  target?: AccountRef;
}

/**
 * An entry in the interactive menu and its `/` palette. `value` must not clash
 * with a core entry; a clashing item is ignored rather than allowed to shadow
 * the core one.
 */
export interface MenuItem {
  value: string;
  slash: string;
  label: string;
  hint?: string;
  /** Empty-prompt hotkey on the home screen; ignored when a core entry has it. */
  hotkey?: string;
  /**
   * Further words the `/` palette accepts for this item. One that is already a
   * core alias, or any entry's value or slash, is ignored.
   */
  aliases?: readonly string[];
  run(context: MenuContext, accountUuid?: string): Promise<void | MenuOutcome>;
}

const menuItems = registry<MenuItem>();

export function registerMenuItem(item: MenuItem): Unregister {
  return menuItems.add(item);
}

export function listMenuItems(): readonly MenuItem[] {
  return menuItems.items;
}

// ---------------------------------------------------------------------------
// Account menu items

/**
 * An entry in the small menu Enter opens on an account row of the dashboard.
 * It is offered only when `when` (if given) says so for that row, and runs with
 * the account the cursor was on. A `value` that is one of the core's verbs, or
 * that a menu item already answers to, is ignored.
 */
export interface AccountMenuItem {
  value: string;
  label: string | ((account: DashboardAccount) => string);
  hint?: string;
  when?(account: DashboardAccount): boolean;
  run(context: MenuContext, accountUuid: string): Promise<void | MenuOutcome>;
}

const accountMenuItems = registry<AccountMenuItem>();

export function registerAccountMenuItem(item: AccountMenuItem): Unregister {
  return accountMenuItems.add(item);
}

export function listAccountMenuItems(): readonly AccountMenuItem[] {
  return accountMenuItems.items;
}
