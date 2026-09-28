import { homedir } from 'node:os';
import path from 'node:path';
import type { Ledger } from '../ledger/log.js';

/**
 * Every directory the CLI might call home.
 *
 * `CLAUDE_CONFIG_DIR` when it is set, `~/.claude` always, plus whatever the
 * caller (or a registered provider) adds. Each consumer keeps only the question
 * it asks of one: transcripts look under `projects/`, the live registry under
 * `sessions/`.
 *
 * Candidates, not certainties: nothing is checked here, so a candidate may be
 * missing and every consumer filters for what it actually needs. Deduplicated
 * as strings only; folding two spellings of one directory is left to the
 * consumer, as `indexAllTranscripts` does.
 */
/**
 * A source of further config directories: returns candidates the same way the
 * defaults are candidates, unchecked. Registered with
 * {@link registerConfigDirProvider}.
 */
export type ConfigDirProvider = (
  env: NodeJS.ProcessEnv,
  home: string,
  context?: { ledger?: Ledger },
) => string[];

const providers: ConfigDirProvider[] = [];

/**
 * The ledger providers are handed, set once per run by whoever resolved it (the
 * same way `useStoreForNames` hands the namer its store). Ambient on purpose:
 * `transcriptRoots` and `sessionRegistryRoots` are called from far too many
 * places to thread a ledger through every one, and a provider that needs none
 * never notices. Unset, providers get `undefined`.
 */
let ledgerForProviders: Ledger | undefined;

/** Sets (or, with `undefined`, clears) the ledger config dir providers receive. */
export function useLedgerForConfigDirs(ledger: Ledger | undefined): void {
  ledgerForProviders = ledger;
}

/** Adds a source of config directories. Returns a function that removes it again. */
export function registerConfigDirProvider(provider: ConfigDirProvider): () => void {
  providers.push(provider);
  return () => {
    const at = providers.indexOf(provider);
    if (at >= 0) providers.splice(at, 1);
  };
}

export function configDirCandidates(
  env: NodeJS.ProcessEnv = process.env,
  extra: string[] = [],
  home: string = homedir(),
): string[] {
  const dirs = new Set<string>();
  for (const dir of [env.CLAUDE_CONFIG_DIR, path.join(home, '.claude'), ...extra]) {
    if (dir) dirs.add(dir);
  }
  for (const provider of providers) {
    for (const dir of provider(env, home, { ledger: ledgerForProviders })) if (dir) dirs.add(dir);
  }
  return [...dirs];
}
