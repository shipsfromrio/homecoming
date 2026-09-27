import { homedir } from 'node:os';
import path from 'node:path';

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
export type ConfigDirProvider = (env: NodeJS.ProcessEnv, home: string) => string[];

const providers: ConfigDirProvider[] = [];

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
    for (const dir of provider(env, home)) if (dir) dirs.add(dir);
  }
  return [...dirs];
}
