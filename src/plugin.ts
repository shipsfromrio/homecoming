import type { Command } from 'commander';
import type { StoreLayout } from './domain/types.js';
import { registerStoreRootCandidates, type StoreRootCandidateSource } from './domain/paths.js';
import { registerReviveInclusion, type ReviveInclusion } from './engine/revive.js';
import {
  registerStatsCounter,
  registerStatsDimension,
  type StatsCounter,
  type StatsDimension,
} from './engine/stats.js';
import {
  registerStoreArgResolver,
  registerStoreProvider,
  type StoreArgResolver,
  type StoreProvider,
} from './engine/stores.js';
import { registerUnstartedSource, type UnstartedSource } from './engine/unstarted.js';
import { registerAgentTool, type AgentTool } from './agentTools.js';
import {
  registerAccountMenuItem,
  registerDoctorCheck,
  registerMenuItem,
  registerSweepPhase,
  type AccountMenuItem,
  type DoctorCheck,
  type MenuItem,
  type PostSweepPhase,
  type Unregister,
} from './extensions.js';
import { registerLedgerReducer, type LedgerReducer } from './ledger/extensions.js';
import type { Ledger } from './ledger/log.js';
import { registerImportUndoProvider, type ImportUndoProvider } from './ops/importUndo.js';
import { registerAppPrefAllowlist, type AppPrefAllowlist } from './store/appPrefs.js';
import { registerConfigDirProvider, type ConfigDirProvider } from './store/configDirs.js';
import { registerCredentialProbe, type CredentialProbe } from './store/config.js';
import {
  registerIdentityObserver,
  registerIdentityReader,
  registerIdentitySource,
  type IdentityObserver,
  type IdentityReader,
  type IdentitySource,
} from './store/identity.js';
import { registerAccountDecorator, type AccountDecorator } from './cli/accountDecorators.js';
import {
  registerCommandExtender,
  registerNextStepHint,
  type CommandExtender,
  type NextStepHint,
} from './cli/commandExtenders.js';
import { registerAccountNamer, type AccountNamer } from './cli/names.js';
import { registerThemeSlot, type ThemeSlot } from './tui/theme.js';
import { registerUpdateChannel, type UpdateChannel } from './update.js';

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
 * - `storeProviders`: installations `--store`, `stores` and `where` should know,
 *   each with an optional `hint` (printed as the store's note) and `remedy`
 *   (added to the error when the directory is gone).
 * - `storeRootCandidates`: further directories, with a priority, to consider
 *   as the default store. The core's own sit at priority 100.
 * - `storeArgResolvers`: further meanings for `--store <arg>`, asked after a
 *   path, a store name and an account, before the path-piece pass.
 * - `configDirProviders`: further CLI config directories to read transcripts and
 *   live sessions from. A provider gets the command's ledger as a third argument.
 * - `accountNamers`: names for accounts nobody labelled.
 * - `identityReaders`: more about an account, read at rest, for the fields the
 *   app's cache left empty.
 * - `identitySources`: an earlier sighting of an account, dated, for what the
 *   cache no longer holds. The core remembers nothing on its own.
 * - `identityObservers`: told whenever a fresh read found something.
 * - `accountDecorators`: a marker, meta and detail lines for an account row.
 * - `sweepPhases`: passes that run after the core sweep passes; with
 *   `interactiveOptions`, what the menu's sweep passes them.
 * - `doctorChecks`: more things `doctor` reports on; findings may carry `data`,
 *   and `json` adds top-level keys to `doctor --json` without replacing one.
 * - `menuItems`: entries in the interactive menu, with optional `aliases`; `run`
 *   may hand back a store or target for the next screens.
 * - `accountMenuItems`: entries in the menu an account row opens.
 * - `commandExtenders`: options and before/after hooks on a core command; a
 *   `before` returning `true` stands in for the core action, and on a command
 *   that writes only when confirmed, only on a confirmed run.
 * - `nextStepHints`: a dim line after a core command, never on `--json`.
 * - `statsDimensions`: further values `stats --by` accepts.
 * - `statsCounters`: more things `stats` counts per record.
 * - `reviveInclusions`: fostered copies `revive` may list. The core lists none,
 *   because a copy's stop belongs to the account the conversation ran in.
 * - `unstartedSources`: further places `unstarted` looks for lost requests. The
 *   core looks only in the account signed in.
 * - `importUndoProviders`: other things `return` can take back, on an unfiltered
 *   run and never while Claude Desktop runs.
 * - `appPrefAllowlists`: guarded preference names this plugin may write. The
 *   core refuses organization policy, compliance and approval preferences.
 * - `credentialProbes`: whether a store's config carries a sign-in token.
 *   Presence only. The core never looks, and a probe must not return the token.
 * - `updateChannel`: where the update check looks and what it suggests running.
 *   One per process; a second is refused.
 * - `themeSlots`: further named colours, per theme.
 * - `agentTools`: tools a host embedding homecoming may offer an agent. The
 *   core runs no agent.
 */
export interface HomecomingPlugin {
  name: string;
  register?(program: Command, context: PluginContext): void;
  ledgerReducers?: LedgerReducer<unknown>[];
  storeProviders?: StoreProvider[];
  storeRootCandidates?: StoreRootCandidateSource[];
  storeArgResolvers?: StoreArgResolver[];
  configDirProviders?: ConfigDirProvider[];
  accountNamers?: AccountNamer[];
  identityReaders?: IdentityReader[];
  identitySources?: IdentitySource[];
  identityObservers?: IdentityObserver[];
  accountDecorators?: AccountDecorator[];
  sweepPhases?: PostSweepPhase[];
  doctorChecks?: DoctorCheck[];
  menuItems?: MenuItem[];
  accountMenuItems?: AccountMenuItem[];
  commandExtenders?: CommandExtender[];
  nextStepHints?: NextStepHint[];
  statsDimensions?: StatsDimension[];
  statsCounters?: StatsCounter[];
  reviveInclusions?: ReviveInclusion[];
  unstartedSources?: UnstartedSource[];
  importUndoProviders?: ImportUndoProvider[];
  appPrefAllowlists?: AppPrefAllowlist[];
  credentialProbes?: CredentialProbe[];
  updateChannel?: UpdateChannel;
  themeSlots?: ThemeSlot[];
  agentTools?: AgentTool[];
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
  const each = <T>(items: readonly T[] | undefined, register: (item: T) => Unregister): void => {
    for (const item of items ?? []) undo.push(register(item));
  };
  try {
    each(plugin.ledgerReducers, registerLedgerReducer);
    each(plugin.storeProviders, registerStoreProvider);
    each(plugin.storeRootCandidates, registerStoreRootCandidates);
    each(plugin.storeArgResolvers, registerStoreArgResolver);
    each(plugin.configDirProviders, registerConfigDirProvider);
    each(plugin.accountNamers, registerAccountNamer);
    each(plugin.identityReaders, registerIdentityReader);
    each(plugin.identitySources, registerIdentitySource);
    each(plugin.identityObservers, registerIdentityObserver);
    each(plugin.accountDecorators, registerAccountDecorator);
    each(plugin.sweepPhases, registerSweepPhase);
    each(plugin.doctorChecks, registerDoctorCheck);
    each(plugin.menuItems, registerMenuItem);
    each(plugin.accountMenuItems, registerAccountMenuItem);
    each(plugin.commandExtenders, registerCommandExtender);
    each(plugin.nextStepHints, registerNextStepHint);
    each(plugin.statsDimensions, registerStatsDimension);
    each(plugin.statsCounters, registerStatsCounter);
    each(plugin.reviveInclusions, registerReviveInclusion);
    each(plugin.unstartedSources, registerUnstartedSource);
    each(plugin.importUndoProviders, registerImportUndoProvider);
    each(plugin.appPrefAllowlists, registerAppPrefAllowlist);
    each(plugin.credentialProbes, registerCredentialProbe);
    if (plugin.updateChannel) undo.push(registerUpdateChannel(plugin.updateChannel));
    each(plugin.themeSlots, registerThemeSlot);
    each(plugin.agentTools, registerAgentTool);
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
