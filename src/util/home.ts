import { homedir } from 'node:os';
import path from 'node:path';

/**
 * The directory everything the tool keeps for itself lives under: the ledger,
 * the scan cache, backups, detached-run logs, the UI preferences and the
 * update-check cache. `FOSTER_HOME` relocates all of it at once; unset, it is
 * `~/.foster` (the name the data had before the rename, kept so an existing
 * ledger is found where it already is).
 *
 * One helper, used by every one of those places, because six copies of the
 * same fallback drifted: the update-check cache and the UI preferences used to
 * ignore `FOSTER_HOME` and land in the real profile regardless.
 */
export function fosterHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return env.FOSTER_HOME ?? path.join(home, '.foster');
}
