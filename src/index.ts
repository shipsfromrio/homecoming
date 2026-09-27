/**
 * The public API: run the CLI with plugins, and the extension points a plugin
 * fills. Everything else under `src/` is internal and may change between minor
 * versions.
 */
export { runCli } from './cli/index.js';
export { definePlugin, usePlugin, type HomecomingPlugin, type PluginContext } from './plugin.js';
export {
  registerDoctorCheck,
  registerMenuItem,
  registerSweepPhase,
  runDoctorChecks,
  runSweepPhases,
  type DoctorCheck,
  type DoctorFinding,
  type MenuContext,
  type MenuItem,
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
  registerStoreProvider,
  resolveStoreArg,
  type KnownStore,
  type StoreProvider,
} from './engine/stores.js';
export {
  configDirCandidates,
  registerConfigDirProvider,
  type ConfigDirProvider,
} from './store/configDirs.js';
export { labelsOf, registerAccountNamer, type AccountNamer } from './cli/names.js';
export { registerReviveInclusion, type ReviveInclusion } from './engine/revive.js';
export { registerUnstartedSource, type UnstartedSource } from './engine/unstarted.js';
export { registerAppPrefAllowlist, type AppPrefAllowlist } from './store/appPrefs.js';
export { registerCredentialProbe, type CredentialProbe } from './store/config.js';
export { commandPath } from './cli/commandPath.js';
export type { AccountRef, StoreLayout } from './domain/types.js';
export { VERSION } from './version.js';
