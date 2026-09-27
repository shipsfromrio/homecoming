import type { Command } from 'commander';
import type { StoreLayout } from './domain/types.js';
import { registerReviveInclusion, type ReviveInclusion } from './engine/revive.js';
import { registerStoreProvider, type StoreProvider } from './engine/stores.js';
import { registerUnstartedSource, type UnstartedSource } from './engine/unstarted.js';
import {
  registerDoctorCheck,
  registerMenuItem,
  registerSweepPhase,
  type DoctorCheck,
  type MenuItem,
  type PostSweepPhase,
  type Unregister,
} from './extensions.js';
import { registerLedgerReducer, type LedgerReducer } from './ledger/extensions.js';
import type { Ledger } from './ledger/log.js';
import { registerAppPrefAllowlist, type AppPrefAllowlist } from './store/appPrefs.js';
import { registerConfigDirProvider, type ConfigDirProvider } from './store/configDirs.js';
import { registerCredentialProbe, type CredentialProbe } from './store/config.js';
import { registerAccountNamer, type AccountNamer } from './cli/names.js';

/** What a plugin's `register` gets besides the program itself. */
export interface PluginContext {
  /** The store and ledger a command acts on, honouring `--store` and `--ledger`. */
  context(command: Command): { store: StoreLayout; ledger: Ledger };
  /** Prints a value as indented JSON, the way every `--json` output does. */
  print(value: unknown): void;
  /** The full command line a leaf answers to, e.g. `app status`. */
  commandPath(command: Command): string;
}

/**
 * Everything one plugin adds. Every field is optional; a plugin with only a
 * name is valid and does nothing.
 *
 * - `register`: add commands (or options, or hooks) to the CLI program.
 * - `ledgerReducers`: fold the plugin's own event kinds into slots of its own;
 *   write them with `Ledger.appendRecord`.
 * - `storeProviders`: installations `--store`, `stores` and `where` should know.
 * - `configDirProviders`: further CLI config directories to read transcripts and
 *   live sessions from.
 * - `accountNamers`: names for accounts nobody labelled.
 * - `sweepPhases`: passes that run after the core sweep passes.
 * - `doctorChecks`: more things `doctor` reports on.
 * - `menuItems`: entries in the interactive menu.
 * - `reviveInclusions`: fostered copies `revive` may list. The core lists none,
 *   because a copy's stop belongs to the account the conversation ran in.
 * - `unstartedSources`: further places `unstarted` looks for lost requests. The
 *   core looks only in the account signed in.
 * - `appPrefAllowlists`: guarded preference names this plugin may write. The
 *   core refuses organization policy, compliance and approval preferences.
 * - `credentialProbes`: whether a store's config carries a sign-in token.
 *   Presence only. The core never looks, and a probe must not return the token.
 */
export interface HomecomingPlugin {
  name: string;
  register?(program: Command, context: PluginContext): void;
  ledgerReducers?: LedgerReducer<unknown>[];
  storeProviders?: StoreProvider[];
  configDirProviders?: ConfigDirProvider[];
  accountNamers?: AccountNamer[];
  sweepPhases?: PostSweepPhase[];
  doctorChecks?: DoctorCheck[];
  menuItems?: MenuItem[];
  reviveInclusions?: ReviveInclusion[];
  unstartedSources?: UnstartedSource[];
  appPrefAllowlists?: AppPrefAllowlist[];
  credentialProbes?: CredentialProbe[];
}

/** Identity function, for type inference at the definition site. */
export function definePlugin<T extends HomecomingPlugin>(plugin: T): T {
  return plugin;
}

/**
 * Registers every extension a plugin carries except its commands (those need
 * the program; see `runCli`). Returns a function that unregisters all of them,
 * in reverse order.
 */
export function usePlugin(plugin: HomecomingPlugin): Unregister {
  const undo: Unregister[] = [];
  try {
    for (const reducer of plugin.ledgerReducers ?? []) undo.push(registerLedgerReducer(reducer));
    for (const provider of plugin.storeProviders ?? []) undo.push(registerStoreProvider(provider));
    for (const provider of plugin.configDirProviders ?? []) {
      undo.push(registerConfigDirProvider(provider));
    }
    for (const namer of plugin.accountNamers ?? []) undo.push(registerAccountNamer(namer));
    for (const phase of plugin.sweepPhases ?? []) undo.push(registerSweepPhase(phase));
    for (const check of plugin.doctorChecks ?? []) undo.push(registerDoctorCheck(check));
    for (const item of plugin.menuItems ?? []) undo.push(registerMenuItem(item));
    for (const inclusion of plugin.reviveInclusions ?? []) {
      undo.push(registerReviveInclusion(inclusion));
    }
    for (const source of plugin.unstartedSources ?? []) {
      undo.push(registerUnstartedSource(source));
    }
    for (const list of plugin.appPrefAllowlists ?? []) undo.push(registerAppPrefAllowlist(list));
    for (const probe of plugin.credentialProbes ?? []) undo.push(registerCredentialProbe(probe));
  } catch (error) {
    for (const step of undo.reverse()) step();
    throw new Error(
      `plugin "${plugin.name}" could not be registered: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return () => {
    for (const step of undo.reverse()) step();
  };
}
