/**
 * The public API: run the CLI with plugins, and the extension points a plugin
 * fills. Everything else under `src/` is internal and may change between minor
 * versions.
 */
export { runCli } from './cli/index.js';
export { definePlugin, usePlugin, type HomecomingPlugin, type PluginContext } from './plugin.js';
export {
  doctorTopLevelJson,
  listAccountMenuItems,
  registerAccountMenuItem,
  registerDoctorCheck,
  registerMenuItem,
  registerSweepPhase,
  runDoctorChecks,
  runSweepPhases,
  sweepPhaseInteractiveOptions,
  type AccountMenuItem,
  type DoctorCheck,
  type DoctorFinding,
  type MenuContext,
  type MenuItem,
  type MenuOutcome,
  type PostSweepContext,
  type PostSweepPhase,
  type PostSweepResult,
  type Unregister,
} from './extensions.js';
export {
  ledgerSlots,
  projectSlot,
  registerLedgerReducer,
  type LedgerReducer,
} from './ledger/extensions.js';
export {
  CORE_EVENT_KINDS,
  Ledger,
  isCoreEvent,
  parseLedgerEvent,
  type ForeignLedgerEvent,
  type LedgerRecord,
} from './ledger/log.js';
export type { LedgerEvent } from './ledger/types.js';
export {
  knownStores,
  registerStoreArgResolver,
  registerStoreProvider,
  resolveStoreArg,
  type KnownStore,
  type ProvidedStore,
  type StoreArgResolver,
  type StoreProvider,
} from './engine/stores.js';
export {
  candidateStoreRoots,
  registerStoreRootCandidates,
  type StoreRootCandidate,
  type StoreRootCandidateSource,
} from './domain/paths.js';
export {
  configDirCandidates,
  registerConfigDirProvider,
  useLedgerForConfigDirs,
  type ConfigDirProvider,
} from './store/configDirs.js';
export { labelsOf, registerAccountNamer, type AccountNamer } from './cli/names.js';
export {
  identityOf,
  registerIdentityObserver,
  registerIdentityReader,
  registerIdentitySource,
  type AccountSighting,
  type IdentityObserver,
  type IdentityReader,
  type IdentitySource,
  type KnownIdentity,
  type ResolvedIdentity,
} from './store/identity.js';
export {
  registerAccountDecorator,
  type AccountDecoration,
  type AccountDecorator,
} from './cli/accountDecorators.js';
export {
  applyCommandExtenders,
  registerCommandExtender,
  registerNextStepHint,
  type CommandExtender,
  type CommandExtenderContext,
  type NextStepHint,
} from './cli/commandExtenders.js';
export {
  registerStatsCounter,
  registerStatsDimension,
  statsDimensionNames,
  type StatsCounter,
  type StatsDimension,
} from './engine/stats.js';
export { registerReviveInclusion, type ReviveInclusion } from './engine/revive.js';
export { registerUnstartedSource, type UnstartedSource } from './engine/unstarted.js';
export {
  registerImportUndoProvider,
  runImportUndo,
  type ImportUndoProvider,
  type ImportUndoResult,
} from './ops/importUndo.js';
export {
  registerAccountPrefCarryAllowlist,
  registerAppPrefAllowlist,
  registerAppPrefWriteNotice,
  type AccountPrefCarryAllowlist,
  type AppPrefAllowlist,
  type AppPrefWriteNotice,
} from './store/appPrefs.js';
export {
  registerLayoutStorageWrite,
  type LayoutStorageWrite,
  type LocalStorageTextWrite,
} from './engine/layout.js';
export { registerUpdateChannel, type UpdateChannel } from './update.js';
export {
  registerThemeSlot,
  themeColor,
  type ColorLevel,
  type Theme,
  type ThemeSlot,
} from './tui/theme.js';
export { meter, paintFg } from './tui/widgets.js';
export { listAgentTools, registerAgentTool, type AgentTool } from './agentTools.js';
export { registerCredentialProbe, type CredentialProbe } from './store/config.js';
export { commandPath } from './cli/commandPath.js';
export type { AccountRef, StoreLayout } from './domain/types.js';
export { VERSION } from './version.js';
