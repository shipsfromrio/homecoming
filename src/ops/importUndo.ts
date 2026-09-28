import type { StoreLayout } from '../domain/types.js';
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
 */
export function runImportUndo(context: {
  store: StoreLayout;
  ledger: Ledger;
  options?: Readonly<Record<string, unknown>>;
  dryRun: boolean;
}): ImportUndoResult {
  const { store, ledger, dryRun } = context;
  const options = context.options ?? {};
  const lines: string[] = [];
  let undone = 0;
  let failed = 0;

  for (const provider of [...importUndoProviders]) {
    let selected: readonly { id: string; line: string }[];
    try {
      selected = provider.select({ store, ledger, options });
    } catch (error) {
      failed += 1;
      lines.push(`${provider.name}: could not list what to undo: ${messageOf(error)}`);
      continue;
    }
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
