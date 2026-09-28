import type { StoreLayout } from '../domain/types.js';
import { inspectApp } from '../engine/safety.js';
import type { Ledger } from '../ledger/log.js';

/**
 * Undoing what something other than homecoming's own fostering brought into a
 * store, alongside `return`.
 *
 * `return` knows how to take back one kind of thing: a fostered copy the ledger
 * recorded. A plugin that brings conversations in by some other route (an
 * import from another tool's files, say) knows what it wrote and how to remove
 * it; the core does not, and should not guess. So the core only asks: each
 * registered provider lists what it would undo (`select`) and undoes one entry
 * at a time (`undo`). The core registers none, so with none registered
 * `runImportUndo` does nothing and says nothing.
 *
 * `dryRun` is passed to `undo` rather than enforced by skipping the call, so a
 * provider can still say what it would do; one that changes anything on a dry
 * run is broken.
 *
 * `return` asks providers only when it was run without a filter (`--title`,
 * `--session`, `--to`, `--to-org`, `--duplicates`, `--branches`): those name
 * fostered copies, and a provider has no way to honour them, so a filtered
 * `return` takes back copies and nothing else. `options` still carries every
 * option the command was given, for flags a plugin added to it. A real run is
 * refused while Claude Desktop is running, as it is for the copies.
 */
export interface ImportUndoProvider {
  name: string;
  select(context: {
    store: StoreLayout;
    ledger: Ledger;
    options: Readonly<Record<string, unknown>>;
  }): readonly { id: string; line: string }[];
  undo(
    id: string,
    context: { store: StoreLayout; ledger: Ledger; dryRun: boolean },
  ): { ok: boolean; line: string };
}

const importUndoProviders: ImportUndoProvider[] = [];

/** Adds a provider. Returns a function that removes it again. */
export function registerImportUndoProvider(provider: ImportUndoProvider): () => void {
  importUndoProviders.push(provider);
  return () => {
    const at = importUndoProviders.indexOf(provider);
    if (at >= 0) importUndoProviders.splice(at, 1);
  };
}

/** Whether any provider is registered, so a caller can say it left them out. */
export function importUndoProvidersRegistered(): boolean {
  return importUndoProviders.length > 0;
}

/**
 * The default refusal before a real undo: the app keeps what it shows in
 * memory and writes it back, so removing files under a running app is not
 * removing them.
 */
export function refuseImportUndoWhileAppRuns(store: StoreLayout): void {
  if (inspectApp(store).running) {
    throw new Error(
      'Claude Desktop is running, and it would write back what a plugin is asked to take away; close it first.',
    );
  }
}

export interface ImportUndoResult {
  /** One line per entry, in the order undone, plus one per provider that failed outright. */
  lines: string[];
  /** Entries a provider reported undone (or, on a dry run, would undo). */
  undone: number;
  /** Entries that failed, plus providers whose `select` threw. */
  failed: number;
}

/**
 * Asks every registered provider what it would undo, then undoes each entry.
 *
 * One provider failing never stops the next: a `select` that throws counts as
 * one failure and a line naming it, and an `undo` that throws or reports
 * `ok: false` counts as one failed entry. Nothing is swallowed silently: every
 * failure has its line.
 *
 * Every provider is asked first and only then is anything undone, so that on a
 * real run `guard` (by default, refused while Claude Desktop runs) decides
 * once, before the first entry, and a refusal leaves everything in place. With
 * nothing selected the guard is not asked.
 */
export function runImportUndo(context: {
  store: StoreLayout;
  ledger: Ledger;
  options?: Readonly<Record<string, unknown>>;
  dryRun: boolean;
  guard?: (store: StoreLayout) => void;
}): ImportUndoResult {
  const { store, ledger, dryRun } = context;
  const guard = context.guard ?? refuseImportUndoWhileAppRuns;
  const options = context.options ?? {};
  const lines: string[] = [];
  let undone = 0;
  let failed = 0;

  const listed: {
    provider: ImportUndoProvider;
    selected: readonly { id: string; line: string }[];
  }[] = [];
  for (const provider of [...importUndoProviders]) {
    try {
      listed.push({ provider, selected: provider.select({ store, ledger, options }) });
    } catch (error) {
      failed += 1;
      lines.push(`${provider.name}: could not list what to undo: ${messageOf(error)}`);
    }
  }

  if (!dryRun && listed.some((entry) => entry.selected.length > 0)) guard(store);

  for (const { provider, selected } of listed) {
    for (const entry of selected) {
      try {
        const outcome = provider.undo(entry.id, { store, ledger, dryRun });
        lines.push(outcome.line);
        if (outcome.ok) undone += 1;
        else failed += 1;
      } catch (error) {
        failed += 1;
        lines.push(`${provider.name}: ${entry.line}: failed: ${messageOf(error)}`);
      }
    }
  }

  return { lines, undone, failed };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
