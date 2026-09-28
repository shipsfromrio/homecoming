import { statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command, Option } from 'commander';
import pc from 'picocolors';
import { DEFAULT_PREFIX } from '../domain/fostering.js';
import {
  candidateStoreRoots,
  comparablePath,
  directoryKey,
  layoutFor,
  storeIdentity,
  listAccountDirs,
  samePath,
  storeRootOfCopy,
} from '../domain/paths.js';
import { currentAccount, requireCurrentAccount, resolveAccountPrefix } from '../engine/account.js';
import { lineage, type Lineage } from '../engine/lineage.js';
import { registerAppPref } from './appPrefCommand.js';
import { sidebarOf } from '../engine/sidebar.js';
import type { AccountRef, DiscoveredSession, StoreLayout } from '../domain/types.js';
import {
  DesktopControlError,
  inspectDesktopFor,
  packagedAppId,
  quitDesktop,
  startDesktop,
  trayNote,
} from '../engine/desktop.js';
import {
  continuedNote,
  continuedSince,
  TWO_SIDEBARS,
  liveBranchNote,
  twoLiveSidebars,
} from '../engine/continued.js';
import {
  fosterSessions,
  returnFosterings,
  summariseOutcomes,
  type Outcome,
} from '../engine/executor.js';
import { assertPurgeConfirmed, purgeConversations, summarisePurge } from '../engine/purge.js';
import { findDuplicates, type DuplicateReport } from '../engine/duplicates.js';
import {
  DEFAULT_MAX_LOST,
  DEFAULT_MAX_LOST_SHARE,
  planConsolidation,
  type ConsolidationEntry,
} from '../engine/consolidate.js';
import { repointCards, undoRequests, type RepointOutcome } from '../engine/repoint.js';
import { retitleCards, undoRetitleRequests } from '../engine/retitle.js';
import {
  candidatesFromStore,
  dateCards,
  planDates,
  requestsFromPlan,
  undoDateRequests,
} from '../engine/dates.js';
import {
  knownStores,
  resolveStoreArg,
  storeExecutable,
  type KnownStore,
} from '../engine/stores.js';
import { inspectApp } from '../engine/safety.js';
import { applyUnclaim, planUnclaim, undoUnclaim } from '../engine/unclaim.js';
import { Ledger } from '../ledger/log.js';
import {
  copySessionIds,
  listActive,
  listDated,
  listRepointed,
  listRetitled,
  listWorktreeReleased,
  project,
  selectByTarget,
  whereCopiesAre,
} from '../ledger/project.js';
import type { LedgerEvent, RepointedCard } from '../ledger/types.js';
import { closingWindowQuits, readConfig } from '../store/config.js';
import {
  cachedProcesses,
  processTableProvenance,
  readProcesses,
  type ProcessTableProvenance,
} from '../util/processes.js';
import { backupPinState, readPinState, writePinState } from '../store/pinstate.js';
import { findPurgeable } from '../store/purge.js';
import { identityLabel, identityOf } from '../store/identity.js';
import { findRestorable } from '../store/restore.js';
import { scanAccount, scanStore, summarise } from '../store/scanner.js';
import {
  cacheDisabled,
  cacheStats,
  clearCache,
  defaultCacheDir,
  openFosterCache,
  type FosterCache,
} from '../store/cache/index.js';
import {
  defaultRescueDeps,
  findStranded,
  openResumeTabs,
  resumeCommandFor,
} from '../engine/rescue.js';
import { defaultReviveDeps, findStopped } from '../engine/revive.js';
import { diskReport, type DiskReport } from '../engine/diskUsage.js';
import {
  computeStats,
  defaultStatsDeps,
  statsBucketName,
  statsDimensionLabel,
  statsDimensionNames,
  type StatsReport,
} from '../engine/stats.js';
import {
  importUndoProvidersRegistered,
  refuseImportUndoWhileAppRuns,
  runImportUndo,
} from '../ops/importUndo.js';
import { extraUnstartedSessions, findUnstarted } from '../engine/unstarted.js';
import { bareSessionId } from '../domain/naming.js';
import { resumeConversation } from '../engine/resume.js';
import {
  buildHostedIndex,
  describeWriters,
  hostedStoreFor,
  liveConversationIds,
  liveSessions,
  pruneRegistry,
  sessionRegistryRoots,
  staleRegistryEntries,
  type HostCandidate,
  type LiveCliSession,
} from '../store/liveSessions.js';
import { selectWriters, stopWriters } from '../ops/writers.js';
import {
  DETACH_DELAY_DEFAULT,
  DETACH_DELAY_MAX,
  DETACH_DELAY_MIN,
  detachNeedsRestart,
  detachNeedsTerminate,
  detachNeedsYes,
  launchDetached,
  liveWritersEnding,
  liveWritersRefusal,
  listDetachedRuns,
  otherLiveWriters,
  parseDetachDelay,
  planDetached,
  restartCommandFromArgv,
  selfHostedCheck,
  sweepDetachArgv,
  tailLines,
  type DetachedPlan,
  type DetachLaunchResult,
  type SweepRestartCarry,
} from '../engine/detach.js';
import {
  firstPrompt,
  indexTranscripts,
  readTranscriptFacts,
  transcriptRoots,
  viewTranscript,
} from '../store/transcripts.js';
import { grepTranscripts } from '../engine/grep.js';
import { resolveConversation } from '../engine/resolveConversation.js';
import {
  readConversationRecords,
  renderConversation,
  type ExportFormat,
} from '../engine/exportConversation.js';
import { checkForUpdate } from '../update.js';
import { VERSION } from '../version.js';
import { applyFilter, parseSince, selectByIds, type SessionFilter } from '../domain/filter.js';
import {
  matchAccountPrefix,
  matchOrganizationPrefix,
  listFosterable,
  measureNeverOpened,
  scanFosterable,
  selectFosterSessions,
} from '../ops/foster.js';
import { partitionByStore, selectReturnTargets } from '../ops/active.js';
import {
  deferredSweepGap,
  RESTART_COMMAND,
  restartPlan,
  runSweep,
  sweepFailedCount,
  sweepMarked,
  type ArchiveSyncPhase,
  type BranchesPhase,
  type FileCardsPhase,
  type SweepReport,
  type TitleSyncPhase,
  type WorktreeClaimsPhase,
} from '../ops/sweep.js';
import { restartAround, restartFailed, type RestartAroundResult } from '../ops/restart.js';
import {
  DEFAULT_DIVERGED_TEMPLATE,
  DEFAULT_OTHER_FILE_TEMPLATE,
  DEFAULT_STALE_TEMPLATE,
} from '../domain/stale.js';
import {
  applyLayout,
  pendingLayoutCounts,
  planLayout,
  totalLayoutPending,
  type ApplyLayoutResult,
  type LayoutPlan,
} from '../engine/layout.js';
import { verifyLayoutGroups, type LayoutGroupsCheck } from '../engine/layoutVerify.js';
import { planVerify, type VerifyReport } from '../engine/verify.js';
import {
  buildWhereReport,
  resolveWhereQuery,
  type WhereEntry,
  type WhereReport,
} from '../engine/where.js';
import { provePlan, type ProveReport } from '../ops/prove.js';
import { readGroupScopesReport, scopeKey } from '../store/groupScopes.js';
import {
  applyViewCopy,
  applyViewSet,
  ENV_STORED_TO_WORD,
  ENV_WORDS,
  GROUP_BY_STORED_TO_WORD,
  GROUP_BY_WORDS,
  planViewCopy,
  planViewSet,
  readViewState,
  recordSignedInViewSighting,
  SORT_STORED_TO_WORD,
  SORT_WORDS,
  STATUS_WORDS,
  type StatusWord,
  type ViewChange,
  type ViewCopyPlan,
  type ViewSetPlan,
  type ViewSetRequest,
} from '../engine/view.js';
import { applyLabel } from '../ops/label.js';
import { labelsOf, manualLabelsOf, useStoreForNames } from './names.js';
import {
  doctorTopLevelJson,
  runDoctorChecks,
  runSweepPhases,
  type DoctorFinding,
} from '../extensions.js';
import { applyCommandExtenders } from './commandExtenders.js';
import { useLedgerForConfigDirs } from '../store/configDirs.js';
import { usePlugin, type HomecomingPlugin, type PluginContext } from '../plugin.js';
import { commandPath } from './commandPath.js';
// Imported statically on purpose: a dynamic import makes the bundler emit a
// separate chunk, and the release ships (and checksums) a single file.
import { runInteractive } from './interactive.js';
import {
  accountTree,
  dateOutcomeLine,
  datePlanLine,
  filePlanLines,
  forkLines,
  formatAge,
  formatBytes,
  formatDate,
  groupByAccount,
  layoutCheckLines,
  layoutFailureLines,
  layoutPendingCountsChanged,
  layoutPlanLines,
  layoutResultLines,
  outcomeLine,
  proveLines,
  purgeLine,
  sessionLine,
  shortId,
  sweepSummary,
  unclaimOutcomeLine,
  unclaimPlanLine,
  updateLine,
  viewCopyRestartCommand,
  viewNoticeLines,
  writtenOf,
} from './render.js';
import { programName } from '../programName.js';

interface GlobalOptions {
  store?: string;
  ledger?: string;
  cache?: boolean;
}

const program = new Command();

program
  .name(`${programName()}`)
  .description(
    "Bring Claude Desktop Code sessions from a previous local account into the current account's sidebar",
  )
  .version(VERSION)
  .option('--store <path>', 'path to the Claude Desktop userData directory')
  .option('--ledger <path>', `path to ${programName()}'s ledger file`)
  .option(
    '--no-cache',
    'skip the persistent scan cache under <FOSTER_HOME>/cache (same as FOSTER_NO_CACHE=1)',
  )
  // Running the bare command opens the guided menu; the subcommands below stay
  // available for scripting and for anyone who prefers one-shot invocations.
  .action(async function (this: Command) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      program.outputHelp();
      return;
    }
    const { store, ledger } = context(this);
    await runInteractive(store, ledger);
  });

function context(command: Command): { store: StoreLayout; ledger: Ledger } {
  const opts = command.optsWithGlobals<GlobalOptions>();
  // The ledger first: it is what lets --store take a piece of a path rather than
  // the whole thing, since the installations it has been used in are recorded
  // nowhere else.
  const ledger = opts.ledger ? new Ledger(opts.ledger) : new Ledger();
  const store = resolveStoreArg(opts.store, () => ledger.read());
  useStoreForNames(store);
  // Config directory providers read the same ledger the command acts on, so a
  // directory a plugin keeps in its own slot follows `--ledger` too.
  useLedgerForConfigDirs(ledger);
  return { store, ledger };
}

/**
 * Open the persistent scan cache for a command that reads one, or nothing when
 * `--no-cache` (or `FOSTER_NO_CACHE`) says to skip it. Commander turns
 * `--no-cache` into `cache: false`; every other case — flag absent, or
 * `--cache` explicitly, which commander also derives from the same
 * declaration — leaves the environment variable the only voice left.
 */
function openCacheFor(command: Command): FosterCache | undefined {
  const opts = command.optsWithGlobals<GlobalOptions>();
  return openFosterCache(process.env, opts.cache === false);
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/**
 * Where copies are written.
 *
 * Without --to this is the account in use, which is what nearly every run wants.
 * With it, another account on disk can be named (for example a new account you
 * are moving to but have not opened yet), but it has to name one directory exactly, so an account holding two organizations is a refusal rather
 * than a coin toss.
 */
function resolveDestination(
  store: StoreLayout,
  accounts: AccountRef[],
  opts: { to?: string; toOrg?: string },
): AccountRef {
  if (opts.to === undefined && opts.toOrg === undefined) {
    return requireCurrentAccount(store, accounts);
  }

  const matches = resolveSources(accounts, opts.to, opts.toOrg, {
    account: '--to',
    organization: '--to-org',
  });

  if (matches.length > 1) {
    const orgs = matches.map((ref) => `  ${ref.organizationUuid}`).join('\n');
    throw new Error(
      `--to matches an account with ${matches.length} organizations. Name one with --to-org:\n${orgs}`,
    );
  }
  return matches[0]!;
}

/**
 * Resolve --from against the accounts on disk.
 *
 * A bare prefix match would silently foster from every account sharing those
 * leading characters, and a typo would be indistinguishable from an empty
 * result, so both are reported instead.
 */
function resolveSources(
  candidates: AccountRef[],
  accountPrefix: string | undefined,
  organizationPrefix: string | undefined,
  flags: { account: string; organization: string } = {
    account: '--from',
    organization: '--from-org',
  },
): AccountRef[] {
  let sources = candidates;

  if (accountPrefix !== undefined) {
    sources = matchAccountPrefix(sources, accountPrefix, flags.account);
  }
  if (organizationPrefix !== undefined) {
    sources = matchOrganizationPrefix(sources, organizationPrefix, flags.organization);
  }
  return sources;
}

function filterFrom(opts: {
  title?: string;
  cwd?: string;
  since?: string;
  all?: boolean;
  archived?: boolean;
  includeScheduled?: boolean;
  includeSpawned?: boolean;
}): SessionFilter {
  const filter: SessionFilter = {
    includeUnfosterable: opts.all ?? false,
    includeArchived: opts.archived ?? false,
    includeScheduled: opts.includeScheduled ?? false,
    includeSpawned: opts.includeSpawned ?? false,
  };
  if (opts.title) filter.title = opts.title;
  if (opts.cwd) filter.cwd = opts.cwd;
  if (opts.since) {
    const since = parseSince(opts.since);
    if (since === undefined)
      throw new Error(`Could not read --since "${opts.since}". Try 30d, 12h or 2w.`);
    filter.since = since;
  }
  return filter;
}

function filterOptions(command: Command): Command {
  return command
    .option('--title <text>', 'only sessions whose title contains this text')
    .option('--cwd <text>', 'only sessions whose working directory contains this text')
    .option('--since <age>', 'only sessions active within this window, e.g. 30d')
    .option('--archived', 'include sessions you archived; the copy stays archived')
    .option(
      '--include-scheduled',
      "include scheduled tasks' conversations; the copy is an ordinary session, not a task",
    )
    .option(
      '--include-spawned',
      'include conversations the app spawned from a background task; the copy is an ordinary session',
    );
}

function sourceOptions(command: Command): Command {
  return command
    .option('--from <accountUuid>', 'only sessions from this account')
    .option('--from-org <organizationUuid>', 'only sessions from this organization')
    .option('--from-store <path>', 'read the sessions from another installation or profile');
}

/**
 * Where sessions are read from, which is not always where they are written.
 *
 * A second profile is a whole separate store, so its sessions are unreachable
 * from the one this process resolved. Reading from one and writing into another
 * is the same operation the engine already performs — only the scan moves.
 */
function resolveSourceStore(
  target: StoreLayout,
  fromStore: string | undefined,
  ledger: Ledger,
): StoreLayout {
  // Abbreviated the same way as --store: the two flags name the same kind of
  // thing, and one of them accepting `work` while the other demanded the whole
  // path would be a distinction without a reason.
  return fromStore ? resolveStoreArg(fromStore, () => ledger.read()) : target;
}

function sameStore(a: StoreLayout, b: StoreLayout): boolean {
  return samePath(a.root, b.root);
}

/**
 * The `process table` line `doctor` prints: which reader answered, and — for
 * anything short of a clean PowerShell read — why the ones before it were
 * passed over. Coloured by how much the answer can be trusted: wmic still has
 * every field PowerShell does, tasklist is missing the ones homecoming reasons
 * from (paths, parent links, command lines, start times), and no reader
 * answering at all is the state that used to look exactly like an idle
 * machine.
 */
function describeProcessTable(provenance: ProcessTableProvenance): string {
  const passedOver = provenance.passedOver.join('; ');
  switch (provenance.source) {
    case 'powershell':
      return 'via PowerShell';
    case 'wmic':
      return `via wmic — ${passedOver}`;
    case 'tasklist':
      return pc.yellow(
        `via tasklist (partial: no paths, parent links, command lines or start times) — ${passedOver}`,
      );
    case 'installed':
      return 'via a test fixture';
    case 'none':
      return pc.red(`unreadable — ${passedOver}`);
  }
}

program
  .command('doctor')
  .helpGroup('Start here:')
  .description('check the environment before doing anything else')
  .option('--json', 'machine-readable output')
  .action(async function (this: Command) {
    const opts = this.optsWithGlobals<GlobalOptions & { json?: boolean }>();
    const roots = candidateStoreRoots();

    if (roots.length === 0 && !opts.store) {
      if (opts.json) print({ store: null, error: 'no Claude Desktop store found' });
      else console.log(pc.red('No Claude Desktop store found — pass --store <path>'));
      process.exitCode = 1;
      return;
    }

    const { store } = context(this);
    const config = readConfig(store);
    // `cachedProcesses` rather than the `readProcesses` default: `inspectApp`
    // here and `runningStores` below each want the process table, and without
    // this they read it twice — a second PowerShell spawn for an answer the
    // first one already gave, inside the same few hundred milliseconds.
    const app = inspectApp(store, undefined, cachedProcesses);
    const ledger = opts.ledger ? new Ledger(opts.ledger) : new Ledger();

    const cache = cacheStats(defaultCacheDir(process.env));

    if (opts.json) {
      const scope = { store, ledger };
      const checks = runDoctorChecks(scope);
      const core = {
        version: VERSION,
        store: store.root,
        candidates: roots.length,
        account: config.lastKnownAccountUuid ?? null,
        updaterLastSeenVersion: config.updaterLastSeenVersion ?? null,
        appRunning: app.running,
        // Populated by the inspectApp call above, so this costs no extra read.
        processTable: processTableProvenance(),
        checks,
        cache: {
          dir: cache.dir,
          disabled: cacheDisabled(process.env, opts.cache === false),
          files: cache.files,
          bytes: cache.bytes,
          newestMtimeMs: cache.newestMtimeMs ?? null,
        },
      };
      // A check's own top-level keys go after the core's and never replace one:
      // `error` is reserved too, for the no-store answer above. A key refused, or
      // a `json` that throws, is reported under that check in `checks`.
      print({ ...core, ...doctorTopLevelJson(scope, [...Object.keys(core), 'error'], checks) });
      return;
    }

    console.log(pc.bold(`${programName()}`));
    console.log(`  ${updateLine(await checkForUpdate())}`);

    console.log(pc.bold('Store'));
    console.log(`  ${store.root}`);
    // Counted as directories, not as paths: the packaged store answers to two
    // names, and "2 candidates found" for one directory reads as a second
    // installation that does not exist.
    //
    // Only when the store was actually discovered: with an explicit --store the
    // candidate list was never consulted, and warning about it invites the reader
    // to doubt the path they just typed.
    const distinct = new Set(roots.map(directoryKey));
    if (!opts.store && distinct.size > 1)
      console.log(pc.yellow(`  (${distinct.size} candidates found, using the first)`));

    console.log(pc.bold('App'));
    // This is the release the updater last saw, which can run ahead of the
    // installed build, so it is labelled for what it is.
    console.log(`  updater sees  ${config.updaterLastSeenVersion ?? 'unknown'}`);
    console.log(`  account       ${config.lastKnownAccountUuid ?? 'unknown'}`);
    // Populated by the inspectApp call above, so this line costs no extra read
    // of the process table — it only reports how the one already taken went.
    console.log(`  process table ${describeProcessTable(processTableProvenance())}`);

    // The same rows `stores` prints, so a first run answers "which store,
    // which account" without a second command.
    console.log(pc.bold('Stores'));
    const known = knownStores(ledger.read());
    const labels = labelsOf(ledger);
    if (known.length === 0) {
      console.log(pc.dim('  none known'));
    } else {
      for (const entry of known) console.log(`  ${storeLine(entry, labels, store)}`);
    }

    console.log(pc.bold('Cache'));
    if (cacheDisabled(process.env, opts.cache === false)) {
      console.log(pc.dim('  disabled (--no-cache or FOSTER_NO_CACHE)'));
    } else if (!cache.files) {
      console.log(pc.dim(`  empty — ${cache.dir}`));
    } else {
      console.log(
        `  ${formatBytes(cache.bytes)} across ${cache.files} file(s), newest ${
          cache.newestMtimeMs === undefined ? 'unknown' : formatDate(cache.newestMtimeMs)
        }`,
      );
      console.log(pc.dim(`  ${cache.dir} — ${programName()} cache clear to empty it`));
    }

    console.log(pc.bold('State'));
    if (app.running) {
      console.log(pc.yellow(`  Claude Desktop is running (${app.evidence.join('; ')})`));
      console.log(pc.dim('  Fostering works anyway; sending copies back wants it closed.'));
    } else {
      console.log(pc.green('  Claude Desktop is not running'));
    }

    printDoctorChecks(runDoctorChecks({ store, ledger }));
  });

/** What registered doctor checks found, one block per check; silent when none are registered. */
function printDoctorChecks(results: { name: string; findings: DoctorFinding[] }[]): void {
  for (const { name, findings } of results) {
    console.log(pc.bold(name));
    if (findings.length === 0) console.log(pc.dim('  nothing to report'));
    for (const finding of findings) {
      const text = `  ${finding.message}`;
      console.log(
        finding.level === 'error'
          ? pc.red(text)
          : finding.level === 'warn'
            ? pc.yellow(text)
            : finding.level === 'ok'
              ? pc.green(text)
              : pc.dim(text),
      );
      if (finding.level === 'error') process.exitCode = 1;
    }
  }
}

program
  .command('stores')
  .helpGroup('Start here:')
  .description(`installations ${programName()} knows about, and what to pass to --store`)
  .option('--json', 'machine-readable output')
  .action(describeStores);

/**
 * How a `KnownStore`'s hint, existence and run state read on one line —
 * `installed app`, `profile`, `used before` or `registered`, `, legacy
 * (pre-MSIX)` for the plain `%APPDATA%\Claude` row that sits beside a packaged
 * install it did not fold into (see `isLegacyAppDataStore`), `, gone` only for
 * a registered name whose directory has since vanished (every other hint
 * requires the directory to exist to be offered at all), `, running` when the
 * lockfile is held.
 */
function storeState(known: KnownStore): string {
  return (
    `${known.hint}${known.legacy ? ', legacy (pre-MSIX)' : ''}` +
    `${known.exists ? '' : ', gone'}${known.running ? ', running' : ''}`
  );
}

/**
 * The account column every store line ends with. Read from config.json's
 * `lastKnownAccountUuid`, which the app itself never consults to decide who is
 * signed in — so this is a hint about which directory the sidebar was on last,
 * not proof of who is signed in now. See docs/guide/how-it-works.md.
 */
function lastSeenAs(known: KnownStore, labels: Map<string, string>): string {
  if (!known.accountUuid) return 'not signed in';
  return labels.get(known.accountUuid) ?? shortId(known.accountUuid);
}

/** One line of `homecoming stores`, shared with the doctor "Profiles" block. */
function storeLine(
  known: KnownStore,
  labels: Map<string, string>,
  current: StoreLayout | undefined,
): string {
  const marker = current && samePath(known.root, current.root) ? pc.green('*') : ' ';
  const label = known.name ?? known.root;
  // A provider's note, when it attached one, closes the line: it explains the
  // entry, and the state and account before it stay where scripts expect them.
  const note = known.note ? ` — ${known.note}` : '';
  return `${marker} ${label} ${pc.dim(`(${storeState(known)}) last seen as ${lastSeenAs(known, labels)}${note}`)}`;
}

/** Prints every installation the ledger and the extensions know, with its state. */
function describeStores(this: Command): void {
  const opts = this.optsWithGlobals<GlobalOptions & { json?: boolean }>();
  const ledger = opts.ledger ? new Ledger(opts.ledger) : new Ledger();
  // Everything the menu offers, printed instead of picked: without this, using
  // homecoming from a script meant knowing a profile's path by heart.
  const stores = knownStores(ledger.read());
  // Resolved leniently, because this is the command you reach for when nothing
  // resolves: refusing to list the installations because it could not pick one
  // of them would be exactly backwards.
  const current = resolveQuietly(opts.store, () => ledger.read());
  const labels = labelsOf(ledger);
  const manual = manualLabelsOf(ledger);

  if (opts.json) {
    print(
      stores.map((known) => {
        const { executable, version } = storeExecutable(known.root);
        return {
          root: known.root,
          name: known.name ?? null,
          knownBy: known.hint,
          // Only ever true for the pre-MSIX %APPDATA%\Claude row sitting beside
          // a packaged install it did not fold into — see `isLegacyAppDataStore`.
          legacy: known.legacy ?? false,
          exists: known.exists,
          running: known.running,
          account: known.accountUuid ?? null,
          label: known.accountUuid ? (manual.get(known.accountUuid) ?? null) : null,
          // Presence only, and only when a plugin's credential probe says so.
          // The core does not look. A stronger signal than `account` above,
          // which is a hint, not proof anything is actually cached.
          signedIn: known.hasTokenCache ?? false,
          executable: executable ?? null,
          version: version ?? null,
          isCurrent: current ? samePath(known.root, current.root) : false,
        };
      }),
    );
    return;
  }

  if (stores.length === 0) {
    console.log('No Claude Desktop installation found.');
    console.log(pc.dim('Pass --store <path> to name one, or start the app once.'));
    return;
  }

  for (const known of stores) console.log(storeLine(known, labels, current));
  const marked = current && stores.some((known) => samePath(known.root, current.root));
  console.log(
    pc.dim(
      `\n${marked ? '* is the one in use. ' : ''}Pass any of these to --store. ` +
        '"last seen as" comes from each installation\'s own config, a hint and not proof of who is signed in now.',
    ),
  );
}

/** The store a bare command would use, or nothing when there is not one. */
function resolveQuietly(
  override: string | undefined,
  readEvents: () => LedgerEvent[],
): StoreLayout | undefined {
  try {
    return resolveStoreArg(override, readEvents);
  } catch {
    return undefined;
  }
}

program
  .command('sweep')
  .helpGroup('Bringing conversations in:')
  .summary('bring the previous account into this one, once — archived and deleted included')
  .description(
    // Wrapped short on purpose: commander re-wraps to the terminal width and
    // keeps these newlines as well, so a long line comes out ragged.
    'Copy every session that can move from the accounts you are leaving into\n' +
      'the one signed in now, once. Archived sessions are included; every branch\n' +
      'of a forked conversation gets a row of its own; conversations the app\n' +
      'deleted that nothing points at are brought back — and the run confirms\n' +
      'all three are exhausted.\n\n' +
      'Archived copies stay archived: they arrive in the archived view rather\n' +
      'than in Recents. So do the branches that stopped: the branch that carried\n' +
      'on keeps its title, the others are marked stale and filed away. Nothing\n' +
      'is hidden and nothing is merged.\n\n' +
      'purge is deliberately not part of this: it destroys transcripts.',
  )
  .option('--to <accountUuid>', 'write the copies into this account instead')
  .option('--to-org <organizationUuid>', 'write the copies into this organization')
  .option('--config-dir <path...>', 'extra Claude config directories to search for conversations')
  .option('--prefix <text>', 'title prefix for the copies (default: none)', DEFAULT_PREFIX)
  .option(
    '--stale-prefix <template>',
    'what a row for a branch that stopped wears in front of its title; {when} is its last answer',
    DEFAULT_STALE_TEMPLATE,
  )
  .option(
    '--branch-prefix <template>',
    'what a row for a branch that went on after the tip wears; it is not filed away',
    DEFAULT_DIVERGED_TEMPLATE,
  )
  .option(
    '--other-file-prefix <template>',
    'what the row wears that is not the one to continue in, when one conversation is shown twice here',
    DEFAULT_OTHER_FILE_TEMPLATE,
  )
  .option(
    '--sync-titles',
    'rewrite copies whose original has been renamed since; leaves a copy you renamed yourself alone',
  )
  .option(
    '--no-archive-sync',
    "leave a copy's archived flag alone instead of matching the most recently active card of the same conversation (on by default)",
  )
  .option(
    '--dates',
    "advance a card's date to its transcript's last answer, so a row stops sinking in the sidebar",
  )
  .option(
    '--undo-retitles',
    'put every marked card back to the title and archived flag the app had before the branch pass touched it',
  )
  .option('--restart', 'restart Claude Desktop afterwards, so the copies show up')
  .option(
    '--detach',
    'restart from outside the app instead — the one way to finish this from a session Claude Desktop itself hosts',
  )
  .option(
    '--detach-delay <seconds>',
    `how long the detached restart waits before it fires (${DETACH_DELAY_MIN}-${DETACH_DELAY_MAX}, default ${DETACH_DELAY_DEFAULT})`,
  )
  .option(
    '--detach-even-with-live',
    'detach anyway even if another live session would be ended by the restart',
  )
  .option(
    '--prove',
    'after planning, independently check every conversation is fully reachable from this account ' +
      `(exit 1 on any gap) — see \`${programName()} verify\` for the layout-groups half of the same question`,
  )
  .option('--json', 'machine-readable output')
  .option('--yes', 'actually write; without it nothing is written')
  .addOption(new Option('--dry-run', 'show what would happen and write nothing').conflicts('yes'))
  .action(async function (this: Command) {
    const { store, ledger } = context(this);
    const opts = this.opts<{
      to?: string;
      toOrg?: string;
      configDir?: string[];
      prefix: string;
      stalePrefix: string;
      branchPrefix: string;
      otherFilePrefix: string;
      syncTitles?: boolean;
      archiveSync?: boolean;
      dates?: boolean;
      undoRetitles?: boolean;
      restart?: boolean;
      detach?: boolean;
      detachDelay?: string;
      detachEvenWithLive?: boolean;
      prove?: boolean;
      json?: boolean;
      yes?: boolean;
      dryRun?: boolean;
    }>();
    const dryRun = opts.dryRun || !opts.yes;
    checkDetachPrereqs({ detach: opts.detach, restart: opts.restart, dryRun });
    const detachDelay = parseDetachDelay(opts.detachDelay);
    if (typeof detachDelay !== 'number') throw new Error(detachDelay.error);

    // No destination to resolve here — the ledger already knows every path,
    // account and prior title an undo needs, the same way `consolidate --undo`
    // needs none of the fork-detection this command otherwise does.
    if (opts.undoRetitles) {
      await undoRetitles(store, ledger, { ...opts, detachDelay }, dryRun);
      return;
    }

    const target = resolveDestination(store, listAccountDirs(store), opts);
    // `--store`/`--ledger` are what picked this installation out; `--to`/
    // `--to-org` are the account this sweep actually wrote into, spelled out
    // rather than left to default (see `SweepRestartCarry`'s own doc comment).
    // Without these a handed-over or detached `homecoming layout --yes --restart`
    // silently ran against the *default* installation and whatever account
    // happened to be current later — measured 24/09/2026, `homecoming --store work
    // sweep --yes --restart --detach` restarting the wrong install entirely.
    const restartCarry: SweepRestartCarry = {
      store: this.optsWithGlobals<GlobalOptions>().store,
      ledger: this.optsWithGlobals<GlobalOptions>().ledger,
      to: target.accountUuid,
      toOrg: target.organizationUuid,
    };
    // Opened once for the whole command and saved in `finally`: every path
    // below this — dry run, --json, --detach, an error thrown mid-restart —
    // must still bank whatever this run's scans learned, or the next run pays
    // the cold cost again for nothing.
    const cache = openCacheFor(this);
    try {
      await runSweepCommand(store, ledger, target, opts, dryRun, detachDelay, cache, restartCarry);
    } finally {
      cache?.save();
    }
  });

async function runSweepCommand(
  store: StoreLayout,
  ledger: Ledger,
  target: AccountRef,
  opts: {
    prefix: string;
    stalePrefix: string;
    branchPrefix: string;
    otherFilePrefix: string;
    syncTitles?: boolean;
    archiveSync?: boolean;
    dates?: boolean;
    restart?: boolean;
    detach?: boolean;
    detachEvenWithLive?: boolean;
    prove?: boolean;
    json?: boolean;
    configDir?: string[];
  },
  dryRun: boolean,
  detachDelay: number,
  cache: FosterCache | undefined,
  restartCarry: SweepRestartCarry,
): Promise<void> {
  // Read-only, and taken before anything else here: a sighting of whichever
  // account the store is actually signed into right now, for the filter
  // menu's machine-wide half (`groupBy`/`sort`) to carry into another
  // account later — see `engine/view.ts`'s `recordSignedInViewSighting`.
  // Silent when nothing is signed in yet.
  recordSignedInViewSighting(store, ledger);

  // Filled by `runSweep` itself, the moment its own `Lineage` and whole-store
  // scan exist — before any pass has written a thing. Only asked for when
  // `--prove` is, so an ordinary sweep pays nothing for it.
  let scanned: { kin: Lineage; scanned: readonly DiscoveredSession[] } | undefined;

  const report = runSweep({
    store,
    ledger,
    target,
    prefix: opts.prefix,
    staleTemplate: opts.stalePrefix,
    divergedTemplate: opts.branchPrefix,
    otherFileTemplate: opts.otherFilePrefix,
    syncTitles: Boolean(opts.syncTitles),
    syncArchive: opts.archiveSync !== false,
    dates: Boolean(opts.dates),
    dryRun,
    configDirs: opts.configDir ?? [],
    cache,
    ...(opts.prove
      ? {
          onScan: (context: { kin: Lineage; scanned: readonly DiscoveredSession[] }) => {
            scanned = context;
          },
        }
      : {}),
  });

  // A dry run writes nothing, so a `failed` count in its report describes a
  // planning problem, not a write that did not land — not the exit-code
  // signal `--yes` gets.
  if (!dryRun && sweepFailedCount(report) > 0) process.exitCode = 1;

  // On a dry run nothing was written, so the scan `runSweep` itself took —
  // handed back through `onScan`, before its own passes ran — already
  // describes the store exactly as this measures it; reusing it is what
  // turns `--prove`'s own `Lineage` build and whole-store scan (the two
  // `runSweepCommand` used to pay for a second time) into nothing at all.
  //
  // On a real run the cards themselves may have changed underneath that
  // scan — a `--yes` run writes new copies — so those are read fresh, after
  // the write, the same as before. The transcripts a `Lineage` is built from
  // are never among what a sweep writes, though, so `kin` is reused either
  // way: it is the expensive half to rebuild (a full transcript walk) and
  // the one nothing here invalidates.
  //
  // A gap reported here is exactly the work `runSweep`'s own plan exists to
  // close. See `ops/prove.ts` for why it is not built from the sweep's own
  // outcomes instead.
  const proveReport = opts.prove
    ? provePlan(
        dryRun ? scanned!.scanned : scanStore(store, copySessionIds(ledger.read()), { slim: true }),
        target,
        scanned!.kin,
      )
    : undefined;

  // Registered phases run after every core pass, on the finished report. A
  // failed write in any of them counts toward the exit code like one in the core.
  const phases = await runSweepPhases({
    store,
    ledger,
    target,
    dryRun,
    report,
    options: opts as Record<string, unknown>,
  });
  const phaseFailures = phases.reduce(
    (sum, phase) => sum + (phase.result?.failed ?? 0) + (phase.error ? 1 : 0),
    0,
  );
  if (!dryRun && phaseFailures > 0) process.exitCode = 1;
  const phasesJson =
    phases.length > 0
      ? {
          phases: Object.fromEntries(
            phases.map((phase) => [
              phase.name,
              phase.error ? { error: phase.error } : (phase.result?.json ?? null),
            ]),
          ),
        }
      : {};

  // Named here, not in `sweepRestart` itself: a layout is planned but never
  // applied by the sweep, so the command handed over on a restart has to be
  // the one that actually finishes the job — `homecoming layout` restarts the
  // app too, so there is still only one command to run outside it.
  //
  // `totalLayoutPending` reads every count the preview carries — groups
  // created, cards assigned, order entries added, routines brought, view
  // keys carried — not just the two an earlier cut checked here, which let
  // a plan with only a pending order entry or only a view-prefs carry print
  // the generic restart line instead of pointing at `homecoming layout`.
  //
  // A sweep that marked rows goes through `homecoming layout` too, even with no
  // layout pending: its gap is the one that writes back any mark the running
  // app saves over in the meantime (`engine/marksBack.ts`).
  const layoutPending = totalLayoutPending(report.layout) > 0 || sweepMarked(report);
  const restartCommand = `${programName()} ${sweepDetachArgv(layoutPending, restartCarry).join(' ')}`;

  if (opts.json) {
    if (opts.detach) {
      const outcome = await runDetach(
        store,
        sweepDetachArgv(layoutPending, restartCarry),
        detachDelay,
        Boolean(opts.detachEvenWithLive),
      );
      print({
        ...sweepJson(report),
        ...(proveReport ? { prove: proveReport } : {}),
        ...phasesJson,
        detach:
          outcome.ok && outcome.plan && outcome.launch
            ? {
                detached: true,
                pid: outcome.launch.pid,
                via: outcome.launch.via,
                log: outcome.plan.logPath,
                vbs: outcome.plan.vbsPath,
                delaySeconds: outcome.plan.delaySeconds,
                argv: outcome.plan.argv,
                ...(outcome.ending ? { ending: outcome.ending } : {}),
              }
            : { detached: false, error: outcome.reason },
      });
      if (!outcome.ok || (proveReport && !proveReport.complete)) process.exitCode = 1;
      return;
    }
    // The one output that has to wait: it is a single object, so the restart
    // has to have happened before any of it can be written.
    const restart = await sweepRestart(
      store,
      Boolean(opts.restart) && !dryRun,
      restartCommand,
      deferredSweepGap(store, ledger, target, report),
    );
    print({
      ...sweepJson(report),
      ...(proveReport ? { prove: proveReport } : {}),
      ...phasesJson,
      restart,
    });
    if ((proveReport && !proveReport.complete) || restartFailed(restart)) process.exitCode = 1;
    return;
  }

  const labels = labelsOf(ledger);
  console.log(
    pc.bold(`Sweeping into ${labels.get(target.accountUuid) ?? shortId(target.accountUuid)}`),
  );

  printPhase('Fostering, archived included', report.fostered.outcomes);
  printBranches(report.branches);
  printFileCards(report.files);
  printPhase('Restoring what the app deleted', report.restored.outcomes);
  printWorktreeClaims(report.worktreeClaims, dryRun);
  if (report.titleSync) printTitleSync(report.titleSync, dryRun);
  printArchiveSync(report.archiveSync, dryRun);

  console.log('');
  for (const line of sweepSummary(report)) console.log(line);

  for (const phase of phases) {
    if (phase.error) {
      console.log(pc.red(`\n${phase.name}: ${phase.error}`));
      continue;
    }
    if (!phase.result?.lines?.length) continue;
    console.log('');
    for (const line of phase.result.lines) console.log(line);
  }

  if (proveReport) printProve(proveReport);

  if (dryRun) {
    console.log(pc.dim('\nRe-run with --yes to write.'));
    return;
  }

  // Last, and only now. Restarting waits up to half a minute for the app to
  // close and a minute more for it to take the store again, and doing that
  // before the report meant a sweep that had already written a few hundred
  // files sat silent for the whole of it — with nothing on screen naming them
  // if the wait was mistaken for a hang and interrupted.
  if (opts.detach) {
    const outcome = await runDetach(
      store,
      sweepDetachArgv(layoutPending, restartCarry),
      detachDelay,
      Boolean(opts.detachEvenWithLive),
    );
    printDetachResult(outcome, false, detachNotNeededNote(store));
    return;
  }
  reportSweepRestart(
    await sweepRestart(
      store,
      Boolean(opts.restart),
      restartCommand,
      deferredSweepGap(store, ledger, target, report),
    ),
  );
}

/**
 * Put the marked cards of one account back to the title and archived flag the
 * app had.
 *
 * Same shape as `undoConsolidation` below: what the write needs — path, account,
 * and what the card wore before the branch pass ever touched it — is already in
 * the ledger, so this scans no transcript and takes no guard, the same as
 * `retitle.ts` itself.
 *
 * Scoped to one account, like everything else this command does. The ledger
 * remembers every card homecoming has ever marked, in every account and every
 * installation it has been pointed at, and a flag on a command that otherwise
 * works on one destination must not quietly reach all of them — `--yes` would
 * be the only thing standing in front of a rewrite the user could not see
 * coming.
 */
async function undoRetitles(
  store: StoreLayout,
  ledger: Ledger,
  opts: {
    to?: string;
    toOrg?: string;
    restart?: boolean;
    detach?: boolean;
    detachDelay: number;
    detachEvenWithLive?: boolean;
    json?: boolean;
  },
  dryRun: boolean,
): Promise<void> {
  const target = resolveDestination(store, listAccountDirs(store), opts);
  const cards = listRetitled(project(ledger.read())).filter(
    (card) =>
      card.target.accountUuid === target.accountUuid &&
      card.target.organizationUuid === target.organizationUuid,
  );
  const outcomes =
    cards.length === 0 ? [] : retitleCards(undoRetitleRequests(cards), { ledger, dryRun });

  // The same run either way: `--json` describes what this call did, rather than
  // printing the ledger and returning before the write it was asked for.
  //
  // `--detach` used to be validated at the top of `sweep`'s own action and then
  // simply never looked at again here — `homecoming sweep --undo-retitles --detach`
  // wrote the undo and then fell into `finish()`, which cannot detach at all.
  // `checkDetachPrereqs` already refused `--detach` without `--yes`, so by the
  // time this is reached with `opts.detach` set, `dryRun` is false.
  if (opts.json) {
    if (opts.detach) {
      const outcome = await runDetach(
        store,
        process.argv.slice(2),
        opts.detachDelay,
        Boolean(opts.detachEvenWithLive),
      );
      print({ target, dryRun, marked: cards.length, outcomes, detach: detachJson(outcome) });
      if (!outcome.ok) process.exitCode = 1;
      return;
    }
    const restart = await restartAround(store, Boolean(opts.restart) && !dryRun, RESTART_COMMAND);
    print({ target, dryRun, marked: cards.length, outcomes, restart });
    return;
  }

  if (cards.length === 0) {
    console.log('No cards are marked in this account — there is nothing to put back.');
    return;
  }

  console.log(pc.bold(`${cards.length} marked row(s) in this account`));
  for (const outcome of outcomes) {
    console.log(
      outcome.status === 'retitled'
        ? titleSyncLine(outcome.from, outcome.to)
        : `  ${pc.red('!')} ${outcome.to}  ${pc.dim(outcome.detail ?? outcome.status)}`,
    );
  }

  if (dryRun) {
    console.log(pc.bold(`\nDry run: ${outcomes.length} would be put back.`));
    console.log(pc.dim('Re-run with --yes to write, before the restart rather than after it.'));
    return;
  }

  const back = outcomes.filter((outcome) => outcome.status === 'retitled').length;
  console.log(pc.bold(`\n${back} put back, ${outcomes.length - back} not.`));

  if (opts.detach) {
    const outcome = await runDetach(
      store,
      process.argv.slice(2),
      opts.detachDelay,
      Boolean(opts.detachEvenWithLive),
    );
    printDetachResult(outcome, false, detachNotNeededNote(store));
    return;
  }
  await finish(store, Boolean(opts.restart));
}

function printPhase(heading: string, outcomes: Outcome[]): void {
  console.log(pc.bold(`\n${heading}`));
  if (outcomes.length === 0) {
    console.log(pc.dim('  nothing to do'));
    return;
  }
  for (const outcome of outcomes) console.log(outcomeLine(outcome));
}

function printBranches(phase: BranchesPhase): void {
  console.log(pc.bold('\nForked conversations, one row per branch'));
  if (phase.forks.length === 0) {
    console.log(pc.dim('  nothing to do'));
    return;
  }
  for (const fork of phase.forks) for (const line of forkLines(fork)) console.log(line);
}

/**
 * The second-file pass, one block per conversation shown here twice: which row
 * is the one to continue in, and what the others now say.
 */
function printFileCards(phase: FileCardsPhase): void {
  console.log(pc.bold('\nConversations shown here more than once'));
  if (phase.plans.length === 0) {
    console.log(pc.dim('  nothing to do'));
    return;
  }
  for (const plan of phase.plans) {
    for (const line of filePlanLines(plan, phase.retitled)) console.log(line);
  }
}

function printWorktreeClaims(phase: WorktreeClaimsPhase, dryRun: boolean): void {
  console.log(pc.bold('\nWorktree claims on copies'));
  if (phase.items.length === 0) {
    console.log(pc.dim('  nothing to do'));
    return;
  }
  if (dryRun) {
    for (const item of phase.items) console.log(unclaimPlanLine(item));
    return;
  }
  for (const outcome of phase.outcomes) console.log(unclaimOutcomeLine(outcome));
}

/**
 * The title pass, one line per copy: what it said, and what its original says.
 *
 * The copies it left alone are counted rather than listed — "renamed here" is
 * the answer for a row somebody named on purpose, and there is nothing for the
 * reader to do about it.
 */
function printTitleSync(phase: TitleSyncPhase, dryRun: boolean): void {
  console.log(pc.bold('\nTitles their originals have moved on from'));
  if (phase.items.length === 0) {
    console.log(pc.dim('  nothing to do'));
  } else if (dryRun) {
    for (const item of phase.items) console.log(titleSyncLine(item.from, item.to));
  } else {
    for (const outcome of phase.outcomes) {
      console.log(
        outcome.status === 'retitled'
          ? titleSyncLine(outcome.from, outcome.to)
          : `  ${pc.red('!')} ${outcome.to}  ${pc.dim(outcome.detail ?? outcome.status)}`,
      );
    }
  }
  const renamed = phase.skipped.filter((skip) => skip.reason === 'renamed-here').length;
  if (renamed > 0) {
    console.log(
      pc.dim(`  ${renamed} left alone: renamed here, so the name was somebody's choice.`),
    );
  }
  // A conflict is the one skip worth reading line by line: both names were
  // chosen by a person, so no rule settles it and the choice is the user's.
  const both = phase.skipped.filter((skip) => skip.reason === 'renamed-both');
  if (both.length > 0) {
    console.log(
      pc.dim(`  ${both.length} named on both sides, left alone — rename the one you want to keep:`),
    );
    for (const skip of both) {
      console.log(pc.dim(`      here: ${skip.here}`));
      console.log(pc.dim(`     there: ${skip.there}`));
    }
  }
}

function titleSyncLine(from: string, to: string): string {
  return `  ${pc.cyan('~')} ${from} ${pc.dim('->')} ${to}`;
}

function printArchiveSync(phase: ArchiveSyncPhase, dryRun: boolean): void {
  const usedHereLast = phase.skipped.filter((skip) => skip.reason === 'used-here-last').length;
  if (phase.items.length === 0 && usedHereLast === 0) return;
  console.log(pc.bold('\nArchived flag out of step with the account last used'));
  if (phase.items.length === 0) {
    console.log(pc.dim('  nothing to do'));
  } else if (dryRun) {
    for (const item of phase.items) {
      console.log(
        `  ${pc.cyan('~')} ${item.to ? 'archive' : 'unarchive'} ${shortId(item.sessionId)}`,
      );
    }
  } else {
    for (const outcome of phase.outcomes) {
      console.log(
        outcome.status === 'written'
          ? `  ${pc.cyan('~')} ${outcome.to ? 'archived' : 'unarchived'} ${shortId(outcome.sessionId)}`
          : `  ${pc.red('!')} ${shortId(outcome.sessionId)}  ${pc.dim(outcome.detail ?? outcome.status)}`,
      );
    }
  }
  // Named on its own, the way `printTitleSync` calls out a rename left alone:
  // this is the count that proves the recency gate is doing its job, not a
  // failure — a row used here more recently than the account that would set
  // the flag is exactly the case that must never be overwritten.
  if (usedHereLast > 0) {
    console.log(
      pc.dim(
        `  ${usedHereLast} left alone: used here more recently than the account that would set the flag.`,
      ),
    );
  }
}

/**
 * `--prove`'s report: sets `process.exitCode` itself, the way a command that
 * finishes past its own `return` cannot otherwise leave a failure behind.
 * The lines themselves are `render.ts`'s `proveLines` — a pure function so
 * the text is testable, the way every other sweep-facing render is.
 */
function printProve(prove: ProveReport): void {
  for (const line of proveLines(prove)) console.log(line);
  if (!prove.complete) process.exitCode = 1;
}

function sweepJson(report: SweepReport): Record<string, unknown> {
  const outcomeJson = (outcome: Outcome) => ({
    originSessionId: outcome.originSessionId,
    title: outcome.title,
    status: outcome.status,
    ...(outcome.detail ? { detail: outcome.detail } : {}),
    ...(outcome.copyPath ? { copyPath: outcome.copyPath } : {}),
    ...(outcome.copyTitle ? { copyTitle: outcome.copyTitle } : {}),
  });
  const phase = (entry: SweepReport['fostered']) => ({
    counts: entry.counts,
    outcomes: entry.outcomes.map(outcomeJson),
  });

  return {
    store: report.store,
    target: report.target,
    dryRun: report.dryRun,
    fostered: phase(report.fostered),
    branches: {
      counts: report.branches.counts,
      archived: report.branches.archived,
      staleTemplate: report.branches.staleTemplate,
      divergedTemplate: report.branches.divergedTemplate,
      forks: report.branches.forks.map((fork) => ({
        root: fork.root,
        tip: fork.tip,
        rows: fork.rows,
        brought: fork.brought.map(outcomeJson),
        retitled: fork.retitled.map((outcome) => ({
          sessionId: outcome.sessionId,
          path: outcome.path,
          from: outcome.from,
          to: outcome.to,
          ...(outcome.archived ? { archived: outcome.archived } : {}),
          status: outcome.status,
          ...(outcome.detail ? { detail: outcome.detail } : {}),
          as: outcome.as,
        })),
        skipped: fork.skipped,
      })),
    },
    restored: phase(report.restored),
    files: {
      archived: report.files.archived,
      otherFileTemplate: report.files.otherFileTemplate,
      plans: report.files.plans.map((plan) => ({
        cliSessionId: plan.cliSessionId,
        working: plan.working,
        rows: plan.rows,
        skipped: plan.skipped,
      })),
      retitled: report.files.retitled.map((outcome) => ({
        sessionId: outcome.sessionId,
        path: outcome.path,
        from: outcome.from,
        to: outcome.to,
        ...(outcome.archived ? { archived: outcome.archived } : {}),
        status: outcome.status,
        ...(outcome.detail ? { detail: outcome.detail } : {}),
        as: outcome.as,
      })),
    },
    worktreeClaims: {
      counts: report.worktreeClaims.counts,
      items: report.worktreeClaims.items,
      outcomes: report.worktreeClaims.outcomes,
    },
    ...(report.titleSync
      ? {
          titleSync: {
            counts: report.titleSync.counts,
            items: report.titleSync.items,
            skipped: report.titleSync.skipped,
            outcomes: report.titleSync.outcomes,
          },
        }
      : {}),
    archiveSync: {
      counts: report.archiveSync.counts,
      items: report.archiveSync.items,
      skipped: report.archiveSync.skipped,
      outcomes: report.archiveSync.outcomes,
    },
    ...(report.dates
      ? {
          dates: {
            counts: report.dates.counts,
            items: report.dates.items,
            outcomes: report.dates.outcomes,
          },
        }
      : {}),
    archived: report.archived,
    liveWriters: report.liveWriters,
    neverComes: report.neverComes,
    layout: report.layout,
    rounds: report.rounds ?? 1,
    unreadableCards: report.unreadableCards,
    ...(report.confirmation ? { confirmation: report.confirmation } : {}),
  };
}

/**
 * What the sweep did about the restart, as data rather than as printing.
 *
 * One routine for both outputs, so `--json` cannot report a restart the text
 * output would have refused. The refusal that matters is the app hosting this
 * very session: `quitDesktop` throws on it, and a sweep that ended in a thrown
 * error after writing everything would read as a failed run. Asked first, it ends
 * with the line to paste into a terminal outside the app instead.
 */
type SweepRestart = RestartAroundResult;

async function sweepRestart(
  store: StoreLayout,
  requested: boolean,
  command: string = RESTART_COMMAND,
  duringGap?: () => void,
): Promise<SweepRestart> {
  return restartAround(store, requested, command, duringGap);
}

// `sweepMarked` and `deferredPinsGap` (now `deferredSweepGap`) moved to
// `ops/sweep.ts` so the TUI's own sweep flow (`src/cli/flows.ts`) can share
// them instead of recomputing a narrower version of the same thing — see the
// doc comments there.

/**
 * `--detach`'s whole implementation, shared by every command that offers it:
 * refuse a restart the tray would swallow before anything is written, check
 * for a live writer the restart would end (besides the session homecoming runs in,
 * which is expected to die with the app), write the `.vbs`, launch it outside
 * the app's process tree, and hand back what to print. Never throws — a launch
 * failure is a refusal like any other, so the caller always has one shape to
 * report.
 */
interface DetachOutcome {
  ok: boolean;
  reason?: string;
  plan?: DetachedPlan;
  launch?: DetachLaunchResult;
  /** Other live sessions the restart will end, named — set only under `--detach-even-with-live`. */
  ending?: string;
}

async function runDetach(
  store: StoreLayout,
  argv: string[],
  delaySeconds: number,
  evenWithLive: boolean,
): Promise<DetachOutcome> {
  // Checked first, and against nothing more than the argv and the store's own
  // tray setting: a detached restart with no way to actually end the app is a
  // wasted wait and a log nobody reads (`detachNeedsTerminate`'s own doc
  // comment has the measurement).
  const terminateRefusal = detachNeedsTerminate({
    closingWindowQuits: closingWindowQuits(store),
    argv,
  });
  if (terminateRefusal) return { ok: false, reason: terminateRefusal };

  const roots = sessionRegistryRoots(process.env);
  const sessions = liveSessions(roots);
  const rows = readProcesses();
  const others = otherLiveWriters(sessions, process.env, selfHostedCheck(rows));
  if (others.length > 0 && !evenWithLive) {
    return { ok: false, reason: liveWritersRefusal(others) };
  }
  // Overridden, the same list is still the one thing worth saying before the
  // restart lands: which sessions it is about to end, named, so the person who
  // asked for it can see what went with the app.
  const ending = others.length > 0 ? liveWritersEnding(others) : undefined;

  const plan = planDetached({
    argv,
    delaySeconds,
    execPath: process.execPath,
    scriptPath: process.argv[1] ?? '',
  });

  try {
    const launch = launchDetached(plan);
    return { ok: true, plan, launch, ...(ending ? { ending } : {}) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error), plan };
  }
}

/**
 * The `--json` shape of a `DetachOutcome`, on its own so a command that folds
 * the detach result into a larger object (`sweep --json`, `layout --json`)
 * builds the same shape `printDetachResult` prints standalone, rather than
 * three copies of the same six fields drifting apart.
 */
function detachJson(outcome: DetachOutcome):
  | {
      detached: true;
      pid: number;
      via: DetachLaunchResult['via'];
      log: string;
      vbs: string;
      delaySeconds: number;
      argv: string[];
      ending?: string;
    }
  | { detached: false; error: string | undefined } {
  if (outcome.ok && outcome.plan && outcome.launch) {
    return {
      detached: true,
      pid: outcome.launch.pid,
      via: outcome.launch.via,
      log: outcome.plan.logPath,
      vbs: outcome.plan.vbsPath,
      delaySeconds: outcome.plan.delaySeconds,
      argv: outcome.plan.argv,
      ...(outcome.ending ? { ending: outcome.ending } : {}),
    };
  }
  return { detached: false, error: outcome.reason };
}

/** `--detach`'s own report, text or `--json` — every command that offers it prints the same shape. */
function printDetachResult(outcome: DetachOutcome, json: boolean, note?: string): void {
  if (json) {
    print(detachJson(outcome));
    if (!outcome.ok) process.exitCode = 1;
    return;
  }

  if (outcome.ok && outcome.plan && outcome.launch) {
    if (note) console.log(pc.dim(`\n${note}`));
    if (outcome.ending) console.log(pc.yellow(`\n${outcome.ending}`));
    console.log(
      pc.bold(
        `\nDetached (pid ${outcome.launch.pid} via ${outcome.launch.via}). In ~` +
          `${outcome.plan.delaySeconds}s Claude Desktop will close — this session with it — ` +
          'and come back.',
      ),
    );
    console.log(pc.dim(`Log: ${outcome.plan.logPath}`));
    console.log(pc.dim(`Verify once it is back with: ${programName()} detached --last`));
    return;
  }
  console.log(pc.yellow(`\n${outcome.reason}`));
  process.exitCode = 1;
}

/** Not needed as a refusal, only as a courtesy: `--detach` still works from outside the app. */
function detachNotNeededNote(store: StoreLayout): string | undefined {
  return restartPlan(store).possible
    ? 'Not inside a hosted session right now, so --detach was not needed — a plain restart would ' +
        'have done the same thing. Running it anyway.'
    : undefined;
}

/**
 * `--detach`'s two prerequisites, checked the same way by every write command
 * that offers it (`sweep`, `layout`, `view set`, `view copy`) — `app restart`
 * needs neither, since it already means "restart" and never means "dry run".
 *
 * Takes the already-computed `dryRun` (`opts.dryRun || !opts.yes`), never the
 * raw `opts.yes` on its own: `sweep`, `layout`, `view set` and `view copy` all
 * compute `dryRun` before calling this, and three of the four used to pass
 * `opts` wholesale instead, reading `opts.yes` directly. `--dry-run` and
 * `--yes` are declared as conflicting options, so the two only ever actually
 * diverged if that Commander wiring were ever loosened — but a check that is
 * only correct by leaning on a constraint declared somewhere else, rather
 * than on the value the caller already worked out, is the kind of thing that
 * silently breaks under refactoring. Passing `dryRun` itself removes the
 * possibility outright.
 */
function checkDetachPrereqs(opts: { detach?: boolean; restart?: boolean; dryRun: boolean }): void {
  if (!opts.detach) return;
  const restartRefusal = detachNeedsRestart({
    detach: true,
    restart: Boolean(opts.restart),
    isRestartItself: false,
  });
  if (restartRefusal) throw new Error(restartRefusal);
  const yesRefusal = detachNeedsYes({ detach: true, yes: !opts.dryRun });
  if (yesRefusal) throw new Error(yesRefusal);
}

/**
 * The three `--detach*` options, identical on every command that offers them —
 * `--restart`/`--terminate` stay each command's own, since their help text
 * (and, for `app restart`, their very name) differs by what the command
 * already does.
 */
function addDetachOptions(cmd: Command): Command {
  return cmd
    .option(
      '--detach',
      'restart from outside the app instead — the one way to finish this from a session Claude Desktop itself hosts',
    )
    .option(
      '--detach-delay <seconds>',
      `how long the detached restart waits before it fires (${DETACH_DELAY_MIN}-${DETACH_DELAY_MAX}, default ${DETACH_DELAY_DEFAULT})`,
    )
    .option(
      '--detach-even-with-live',
      'detach anyway even if another live session would be ended by the restart',
    );
}

/**
 * Refuses a write that needs the app closed, found it running, and was not
 * asked to restart it — the same check and the same words `layout`, `view
 * set` and `view copy` each wrote out by hand.
 */
function refuseIfAppRunning(store: StoreLayout): void {
  if (inspectApp(store).running) {
    throw new Error(
      'Claude Desktop rewrites its own config while it runs; close it or add --restart.',
    );
  }
}

function reportSweepRestart(restart: SweepRestart): void {
  if (restart.done) {
    console.log(pc.bold('\nClaude Desktop is up, with the sidebar rebuilt.'));
    return;
  }
  if (restart.reason) {
    console.log(pc.yellow(`\n${restart.reason}`));
    console.log(`  ${restart.command}`);
    // Same predicate `layout`/`view set`/`view copy` use at their own
    // `if (!restart.done)`: a restart this run asked for (`--restart`) but
    // that did not finish is a failed run, not a clean one with a note.
    if (restartFailed(restart)) process.exitCode = 1;
    return;
  }
  console.log(
    pc.dim(
      `\nThe copies are invisible until the app re-reads its directory: ${restart.command}` +
        ' — or re-run with --restart.',
    ),
  );
}

program
  .command('scan')
  .helpGroup('Bringing conversations in:')
  .description('read-only inventory of accounts and sessions')
  .option('--json', 'machine-readable output')
  .action(function (this: Command) {
    const { store, ledger } = context(this);
    const config = readConfig(store);
    const accounts = summarise(store, config.lastKnownAccountUuid, copySessionIds(ledger.read()));
    const labels = labelsOf(ledger);
    const manual = manualLabelsOf(ledger);

    if (this.opts<{ json?: boolean }>().json) {
      print(
        accounts.map((row) => ({
          accountUuid: row.account.accountUuid,
          organizationUuid: row.account.organizationUuid,
          label: manual.get(row.account.accountUuid) ?? null,
          isCurrent: row.isCurrent,
          sessions: row.nativeCount,
          fostered: row.copyCount,
        })),
      );
      return;
    }

    if (accounts.length === 0) {
      console.log('No account directories found.');
      return;
    }

    console.log(accountTree(groupByAccount(accounts), labels));
  });

sourceOptions(
  filterOptions(
    program
      .command('list')
      .helpGroup('Bringing conversations in:')
      .description('list sessions available to foster'),
  ),
)
  .option('--all', 'also show sessions that could never appear in the sidebar')
  .option('--json', 'machine-readable output')
  .action(function (this: Command) {
    const { store, ledger } = context(this);
    const opts = this.opts<{
      from?: string;
      fromOrg?: string;
      fromStore?: string;
      all?: boolean;
      json?: boolean;
    }>();
    const sourceStore = resolveSourceStore(store, opts.fromStore, ledger);
    const accounts = listAccountDirs(sourceStore);
    // Everything in another store is a candidate; only within one store does the
    // account in use need excluding, because there its sessions are already here.
    const current = sameStore(sourceStore, store) ? currentAccount(store, accounts) : undefined;

    const sources = resolveSources(
      accounts.filter((account) => account.accountUuid !== current?.accountUuid),
      opts.from,
      opts.fromOrg,
    );
    // The whole store is read even though only these accounts are offered: what
    // makes a copy the last card of its conversation is decided by the accounts
    // that are not on offer.
    //
    // `here` is built from `store` — the local install — never `sourceStore`:
    // `current`'s own cards live there regardless of which store the candidates
    // are being read from. Undefined for a cross-store listing, which has no
    // settled destination to compare reach against.
    const here = current
      ? sidebarOf(store, current, copySessionIds(ledger.read()), lineage())
      : undefined;
    const candidates = listFosterable(sourceStore, sources, ledger, filterFrom(this.opts()), here);

    if (opts.json) {
      // Measured here and nowhere else in this command: a caller reading JSON is
      // the one deciding what a held-back session is worth, and "never opened"
      // alone does not say whether there is a conversation behind it. Null when
      // the question does not apply, so a reader can tell "not measured" from a
      // measurement of nothing.
      print(
        measureNeverOpened(candidates).map((session) => ({
          sessionId: session.data.sessionId,
          title: session.data.title ?? null,
          cwd: session.data.cwd ?? null,
          lastActivityAt: session.data.lastActivityAt ?? null,
          accountUuid: session.account.accountUuid,
          organizationUuid: session.account.organizationUuid,
          fosterable: session.reasons.length === 0,
          reasons: session.reasons,
          transcriptBytes: session.transcriptBytes ?? null,
        })),
      );
      return;
    }

    if (candidates.length === 0) {
      console.log('Nothing matches.');
      return;
    }

    for (const session of candidates) console.log(sessionLine(session));
    console.log(pc.bold(`\n${candidates.length} session(s)`));
  });

sourceOptions(
  filterOptions(
    program
      .command('foster')
      .helpGroup('Bringing conversations in:')
      .description('copy sessions from another account into the current one')
      .option('--session <id...>', 'only these sessions, by id or unique prefix')
      .option('--to <accountUuid>', 'write the copies into this account instead')
      .option('--to-org <organizationUuid>', 'write the copies into this organization')
      .option('--prefix <text>', 'title prefix for the copies (default: none)', DEFAULT_PREFIX)
      .option('--restart', 'restart Claude Desktop afterwards, so the copies show up')
      .option('--yes', 'actually write; without it nothing is written')
      .addOption(
        // Passing both used to silently win for --dry-run, so a script that meant
        // to write quietly did not. Naming the conflict says so instead.
        new Option('--dry-run', 'show what would happen and write nothing').conflicts('yes'),
      ),
  ),
).action(async function (this: Command) {
  const { store, ledger } = context(this);
  const opts = this.opts<{
    title?: string;
    cwd?: string;
    since?: string;
    archived?: boolean;
    includeScheduled?: boolean;
    includeSpawned?: boolean;
    session?: string[];
    from?: string;
    fromOrg?: string;
    fromStore?: string;
    to?: string;
    toOrg?: string;
    prefix: string;
    restart?: boolean;
    yes?: boolean;
    dryRun?: boolean;
  }>();

  const target = resolveDestination(store, listAccountDirs(store), opts);
  const sourceStore = resolveSourceStore(store, opts.fromStore, ledger);
  const crossStore = !sameStore(sourceStore, store);
  const filter = filterFrom(opts);

  // Only the directory the copies are going to is excluded, and only when the
  // sessions come from the same store: another organization of the same account
  // is just as invisible and just as fosterable, and a different store shares no
  // directory with the destination at all.
  const sources = resolveSources(
    listAccountDirs(sourceStore).filter(
      (ref) =>
        crossStore ||
        !(
          ref.accountUuid === target.accountUuid && ref.organizationUuid === target.organizationUuid
        ),
    ),
    opts.from,
    opts.fromOrg,
  );

  // Sessions that can never appear in the sidebar are always excluded here:
  // offering them would only produce copies the app silently never lists.
  //
  // `here` reads `store`, not `sourceStore`: the copies are about to land in
  // `target`'s directory under the local install, whichever store the
  // candidates themselves are being read from.
  const here = sidebarOf(store, target, copySessionIds(ledger.read()), lineage());
  let candidates = listFosterable(sourceStore, sources, ledger, filter, here);

  if (opts.session?.length) {
    try {
      // The unfiltered scan comes along so an id naming a session that exists but
      // is held back can be answered with the reason and the flag that lifts it.
      // Pointing at "homecoming list" was actively wrong there: the session is on it.
      candidates = selectFosterSessions(
        candidates,
        opts.session,
        scanFosterable(sourceStore, sources, ledger),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const unknown = message.startsWith('No session matches');
      throw new Error(
        unknown ? `${message}\nRun "${programName()} list --all" to see the ids.` : message,
      );
    }
  }

  if (candidates.length === 0) {
    console.log('Nothing to foster.');
    return;
  }

  // Default to a dry run: writing is opt-in via --yes.
  const dryRun = opts.dryRun || !opts.yes;
  const outcomes = fosterSessions(candidates, {
    store,
    ledger,
    target,
    sourceStore: sourceStore.root,
    prefix: opts.prefix,
    dryRun,
    includeArchived: Boolean(opts.archived),
    includeScheduled: Boolean(opts.includeScheduled),
    includeSpawned: Boolean(opts.includeSpawned),
    // A conversation with a live writer branches when its copy is opened, which
    // is the one failure that reads as foster losing work. Reported, never
    // refused: copying the session you are working in is the ordinary case.
    live: liveConversationIds(),
    // Naming sessions one by one is a decision about those sessions, and only
    // that brings back a copy the user deleted in the app.
    explicit: Boolean(opts.session?.length),
  });

  for (const outcome of outcomes) console.log(outcomeLine(outcome));
  const counts = summariseOutcomes(outcomes);

  // Named outright when the sessions came from elsewhere: the destination is
  // stated everywhere already, and a copy arriving from another installation is
  // exactly the case where "from where?" is not obvious.
  if (crossStore) console.log(pc.dim(`\nfrom ${sourceStore.root}`));

  // Said on the dry run too: it is the moment before anything is written, which
  // is exactly when knowing changes what someone does next.
  const writers = describeWriters(
    outcomes.map((outcome) => outcome.live).filter((id): id is string => Boolean(id)),
    sessionRegistryRoots(process.env),
  );

  // Refusing a second row for one piece of work is right. Leaving the account on
  // the half that stopped without saying so was not — and a per-line note scrolls
  // off the screen on a sweep of a few hundred, so it is counted here too.
  const behind = outcomes.filter((outcome) => outcome.standing?.ahead).length;
  const forkNote =
    behind === 0
      ? ''
      : pc.yellow(
          `\n${behind} of the skipped ${behind === 1 ? 'is' : 'are'} the half of a fork that carried on; ` +
            `this account is showing the half that stopped.\n` +
            `${programName()} consolidate lists them with their record counts. Run it before the restart, ` +
            'not after: a card the app itself made waits either way.',
        );

  if (dryRun) {
    console.log(
      pc.bold(`\nDry run: ${counts.fostered} would be fostered, ${counts.skipped} skipped.`),
    );
    if (writers.length > 0) console.log(pc.yellow(`\n${liveBranchNote(writers)}`));
    if (forkNote) console.log(forkNote);
    console.log(pc.dim('Re-run with --yes to write.'));
    return;
  }

  console.log(
    pc.bold(`\n${counts.fostered} fostered, ${counts.skipped} skipped, ${counts.failed} failed.`),
  );
  if (counts.failed > 0) process.exitCode = 1;
  if (writers.length > 0) console.log(pc.yellow(`\n${liveBranchNote(writers)}`));
  if (forkNote) console.log(forkNote);
  if (counts.fostered > 0 && twoLiveSidebars(sourceStore, store)) {
    console.log(pc.yellow(`\n${TWO_SIDEBARS}`));
  }
  await finish(store, Boolean(opts.restart));
});

/**
 * The whole job as one command.
 *
 * Everything below is what `homecoming foster --archived` and `homecoming restore`
 * already do, chained in the order that makes the second question meaningful,
 * with the two things a hand-run sequence never produced: a re-scan that says the
 * sweep is finished, and a count of what will never come at all.
 */
program
  .command('restore')
  .helpGroup('Bringing conversations in:')
  .description('bring back sessions deleted in the app, from the conversations they left behind')
  .option('--title <text>', 'only conversations whose title contains this text')
  .option('--session <id...>', 'only these conversations, by id or unique prefix')
  .option('--to <accountUuid>', 'write them into this account instead')
  .option('--to-org <organizationUuid>', 'write them into this organization')
  .option('--config-dir <path...>', 'extra Claude config directories to search for conversations')
  .option(
    '--prefix <text>',
    'title prefix for the restored sessions (default: none)',
    DEFAULT_PREFIX,
  )
  .option('--restart', 'restart Claude Desktop afterwards')
  .option('--yes', 'actually write; without it nothing is written')
  .addOption(new Option('--dry-run', 'show what would happen and write nothing').conflicts('yes'))
  .action(async function (this: Command) {
    const { store, ledger } = context(this);
    const opts = this.opts<{
      title?: string;
      session?: string[];
      to?: string;
      toOrg?: string;
      configDir?: string[];
      prefix: string;
      restart?: boolean;
      yes?: boolean;
      dryRun?: boolean;
    }>();

    const target = resolveDestination(store, listAccountDirs(store), opts);
    let candidates = findRestorable(store, process.env, opts.configDir ?? []).map(
      (entry) => entry.session,
    );

    if (opts.title) {
      candidates = applyFilter(candidates, { title: opts.title });
    }
    if (opts.session?.length) {
      const { selected, unmatched } = selectByIds(candidates, opts.session);
      if (unmatched.length > 0) {
        throw new Error(
          `No deleted conversation matches --session ${unmatched.join(', ')}.\n` +
            `Run "${programName()} restore" with no --yes to see what is available.`,
        );
      }
      candidates = selected;
    }

    if (candidates.length === 0) {
      console.log('Nothing to restore: no deleted session still has its conversation on disk.');
      return;
    }

    const dryRun = opts.dryRun || !opts.yes;
    const outcomes = fosterSessions(candidates, {
      store,
      ledger,
      target,
      prefix: opts.prefix,
      dryRun,
      // The same rule "foster --session" follows, and for the same reason. A bulk
      // restore rightly skips a conversation this account already shows a branch
      // of — a second row for one piece of work is not a favour. Naming it is a
      // decision about that conversation, and until this was passed there was no
      // way to make it: the branch the deletion took with it held records no card
      // here had, and every route to them was refused. That refusal also made the
      // "homecoming consolidate" this printed unreachable, since consolidate only
      // sees forks between cards that exist.
      explicit: Boolean(opts.session?.length),
    });

    for (const outcome of outcomes) console.log(outcomeLine(outcome, { restoring: true }));
    const counts = summariseOutcomes(outcomes);

    if (dryRun) {
      console.log(pc.bold(`\nDry run: ${counts.fostered} would be restored.`));
      console.log(pc.dim('Re-run with --yes to write.'));
      return;
    }

    console.log(pc.bold(`\n${counts.fostered} restored, ${counts.failed} failed.`));
    if (counts.failed > 0) process.exitCode = 1;
    await finish(store, Boolean(opts.restart));
  });

program
  .command('return')
  .helpGroup('After the sweep:')
  .description('remove fostered copies, restoring the previous state')
  .option('--title <text>', 'only fosterings whose original title contains this text')
  .option('--session <id...>', 'only these origin sessions, by id or unique prefix')
  .option('--to <accountUuid>', 'only copies written into this account')
  .option('--to-org <organizationUuid>', 'only copies written into this organization')
  .option('--all-stores', 'include copies written into other installations')
  .option('--duplicates', 'only copies of a conversation their account already had')
  .option('--branches', 'only copies of a conversation their account already had a branch of')
  .option('--restart', 'restart Claude Desktop afterwards')
  .option('--yes', 'actually remove; without it nothing is removed')
  .addOption(new Option('--dry-run', 'show what would happen and remove nothing').conflicts('yes'))
  .action(async function (this: Command) {
    const { store, ledger } = context(this);
    const opts = this.opts<{
      title?: string;
      session?: string[];
      to?: string;
      toOrg?: string;
      allStores?: boolean;
      duplicates?: boolean;
      branches?: boolean;
      restart?: boolean;
      yes?: boolean;
      dryRun?: boolean;
    }>();

    const { selected: active, elsewhere } = selectReturnTargets(store, ledger, {
      allStores: opts.allStores,
      to: opts.to,
      toOrg: opts.toOrg,
      duplicates: opts.duplicates,
      branches: opts.branches,
      title: opts.title,
      sessionIds: opts.session,
    });

    if (elsewhere > 0) {
      console.log(
        pc.dim(
          `${elsewhere} more ${elsewhere === 1 ? 'copy is' : 'copies are'} in other installations — pass --all-stores to include them.`,
        ),
      );
    }

    const dryRun = opts.dryRun || !opts.yes;
    // Anything else a plugin brought in and knows how to take back, after the
    // copies and under the same --yes. The core registers no provider, so
    // without a plugin this is empty and `return` is exactly the copies. The
    // filters name fostered copies and a provider cannot honour them, so a
    // filtered run leaves what plugins imported alone rather than sweeping
    // every one of them under a request that asked for less.
    const filtered = Boolean(
      opts.title !== undefined ||
      (opts.session?.length ?? 0) > 0 ||
      opts.to !== undefined ||
      opts.toOrg !== undefined ||
      opts.duplicates ||
      opts.branches,
    );
    const asksImports = !filtered && importUndoProvidersRegistered();
    // Refused before the first copy goes, so a running app never ends with the
    // copies returned and the imports left half done.
    if (asksImports && !dryRun) refuseImportUndoWhileAppRuns(store);
    // Measured before the copies go: for entries written before the ledger kept
    // the conversation id, the copy itself is where that id is read from.
    const continued = active.length > 0 ? continuedSince(store, active) : [];
    const outcomes = active.length > 0 ? returnFosterings(active, { store, ledger, dryRun }) : [];
    const imports = asksImports
      ? runImportUndo({ store, ledger, options: opts, dryRun })
      : { lines: [], undone: 0, failed: 0 };
    if (filtered && importUndoProvidersRegistered()) {
      console.log(
        pc.dim(
          'What plugins imported is left alone: a filtered return takes back fostered copies only.',
        ),
      );
    }

    if (outcomes.length === 0 && imports.lines.length === 0) {
      console.log('Nothing is fostered.');
      return;
    }

    for (const outcome of outcomes) console.log(outcomeLine(outcome));
    for (const line of imports.lines) console.log(line);

    const counts = summariseOutcomes(outcomes);
    const returned = counts.returned + imports.undone;
    const failed = counts.failed + imports.failed;
    if (dryRun) {
      console.log(pc.bold(`\nDry run: ${returned} would be returned.`));
      console.log(pc.dim('Re-run with --yes to remove.'));
      return;
    }

    console.log(pc.bold(`\n${returned} returned, ${failed} failed.`));
    if (failed > 0) process.exitCode = 1;
    if (continued.length > 0)
      console.log(
        pc.dim(`
${continuedNote(continued)}`),
      );
    await finish(store, Boolean(opts.restart));
  });

program
  .command('consolidate')
  .helpGroup('After the sweep:')
  .description('one row per piece of work, on the branch that carried on')
  .option('--to <accountUuid>', 'only cards in this account')
  .option('--session <id...>', 'only forks involving these conversations or cards')
  .option(
    '--max-lost <n>',
    'leave a fork alone when the halves not kept hold more records than this',
    String(DEFAULT_MAX_LOST),
  )
  .option(
    '--max-lost-share <percent>',
    'leave a fork alone when the halves not kept are worth more than this much of the one that stays',
    String(Math.round(DEFAULT_MAX_LOST_SHARE * 100)),
  )
  .option('--undo', 'put repointed cards back where the app had them')
  .option('--restart', 'restart Claude Desktop afterwards')
  .option('--json', 'machine-readable output')
  .option('--yes', 'actually write; without it nothing is written')
  .addOption(new Option('--dry-run', 'show what would happen and write nothing').conflicts('yes'))
  .action(async function (this: Command) {
    const { store, ledger } = context(this);
    const opts = this.opts<{
      to?: string;
      session?: string[];
      maxLost?: string;
      maxLostShare?: string;
      undo?: boolean;
      restart?: boolean;
      json?: boolean;
      yes?: boolean;
      dryRun?: boolean;
    }>();
    const dryRun = opts.dryRun || !opts.yes;

    if (opts.undo) {
      await undoConsolidation(store, ledger, opts, dryRun);
      return;
    }

    const maxLost = Number(opts.maxLost);
    if (!Number.isInteger(maxLost) || maxLost < 0) {
      throw new Error(`--max-lost wants a whole number of records, not "${opts.maxLost}".`);
    }

    const maxLostShare = Number(opts.maxLostShare);
    if (!Number.isFinite(maxLostShare) || maxLostShare < 0 || maxLostShare > 100) {
      throw new Error(
        `--max-lost-share wants a percentage between 0 and 100, not "${opts.maxLostShare}".`,
      );
    }

    const entries = planConsolidation({
      store,
      ledger,
      maxLost,
      maxLostShare: maxLostShare / 100,
      ...(opts.to === undefined ? {} : { to: opts.to }),
      ...(opts.session === undefined ? {} : { sessionIds: opts.session }),
    });
    const acting = entries.filter((entry) => entry.status === 'consolidate');
    const diverged = entries.filter((entry) => entry.status === 'diverged');
    const appMade = entries.filter((entry) => entry.status === 'app-made');
    const jsonEntries = (): Record<string, unknown>[] =>
      entries.filter((entry) => entry.status !== 'settled').map(consolidationJson);

    // Same order as `unclaim`/`dates`/`sweep --undo-retitles`: on a dry run
    // nothing has been written, so the plan is all `--json` has to show. With
    // `--yes` the write happens first (below) and `--json` reports what was
    // actually done, rather than degrading to a dry-run preview a scripted
    // caller would mistake for the real thing.
    if (opts.json && dryRun) {
      print(jsonEntries());
      return;
    }

    if (!opts.json) {
      if (acting.length === 0 && diverged.length === 0 && appMade.length === 0) {
        console.log('Nothing is forked here — every conversation has one card per account.');
        return;
      }

      for (const entry of acting) console.log(consolidationLines(entry).join('\n'));
      for (const entry of diverged) console.log(divergedLines(entry).join('\n'));
      for (const entry of appMade) console.log(appMadeLines(entry).join('\n'));
    }

    const rows = acting.length;
    const moves = acting.filter((entry) => entry.repoint).length;
    const drops = acting.reduce((sum, entry) => sum + entry.remove.length, 0);

    if (dryRun) {
      console.log(
        pc.bold(
          `\nDry run: ${rows} ${rows === 1 ? 'row' : 'rows'} would be consolidated ` +
            `(${moves} moved, ${drops} removed).`,
        ),
      );
      if (diverged.length > 0) {
        // Two gates, so "raise --max-lost" is only the whole answer when that is
        // what stopped every one of them. The per-fork lines above already name
        // the right flag with the right number; this one stops contradicting them.
        const byShare = diverged.some((entry) => entry.divergedBy === 'share');
        const byCount = diverged.some((entry) => entry.divergedBy !== 'share');
        const raise = byShare && byCount ? '' : byShare ? ' --max-lost-share' : ' --max-lost';
        console.log(
          pc.dim(
            raise === ''
              ? `${diverged.length} left alone — each says above what would include it.`
              : `${diverged.length} left alone — raise${raise} to include them.`,
          ),
        );
      }
      if (appMade.length > 0) {
        console.log(pc.dim(`${appMade.length} left to the app — see above.`));
      }
      console.log(pc.dim('Re-run with --yes to write, before the restart rather than after it.'));
      return;
    }

    // Repoint before removing. Both want a closed app, and doing the write that
    // keeps a row before the one that drops a row means a refusal half-way leaves
    // more rows than it should rather than fewer.
    const moved = repointCards(
      acting.flatMap((entry) => (entry.repoint ? [entry.repoint] : [])),
      { store, ledger },
    );
    const removed = returnFosterings(
      acting.flatMap((entry) => entry.remove),
      { store, ledger },
    );

    const counts = summariseOutcomes(removed);
    const failed = moved.filter((outcome) => outcome.status === 'failed').length + counts.failed;
    if (failed > 0) process.exitCode = 1;

    // Same shape as `sweep`/`layout`/`view set`: the write above already
    // happened, so `--restart` here is only ever quit-then-start, never a
    // write-in-the-gap — `restartAround` with no `duringGap` is exactly
    // `sweepRestart`'s own call. Run and reported under `--json` too, so
    // `--restart --json` together no longer drops the restart silently the
    // way returning before `finish` (text-only, and never awaited on this
    // branch) used to.
    if (opts.json) {
      const restart = await restartAround(store, Boolean(opts.restart), RESTART_COMMAND);
      print({ entries: jsonEntries(), moved, removed, restart });
      if (opts.restart && !restart.done) process.exitCode = 1;
      return;
    }

    for (const outcome of moved) console.log(repointLine(outcome));
    for (const outcome of removed) console.log(outcomeLine(outcome));

    console.log(
      pc.bold(
        `\n${moved.filter((o) => o.status === 'repointed').length} moved, ` +
          `${counts.returned} removed, ${failed} failed.`,
      ),
    );
    if (diverged.length > 0) {
      console.log(pc.dim(`${diverged.length} fork(s) left alone — see above.`));
    }
    if (appMade.length > 0) {
      console.log(pc.dim(`${appMade.length} left to the app — see above.`));
    }
    console.log(pc.dim(`Undo the moves with: ${programName()} consolidate --undo --yes`));
    await finish(store, Boolean(opts.restart));
  });

async function undoConsolidation(
  store: StoreLayout,
  ledger: Ledger,
  opts: { to?: string; session?: string[]; restart?: boolean; json?: boolean },
  dryRun: boolean,
): Promise<void> {
  let cards = listRepointed(project(ledger.read()));
  if (opts.to !== undefined) {
    const to = opts.to;
    cards = cards.filter((card) => card.target.accountUuid.startsWith(to));
  }

  // Narrowing the undo has to narrow it. Reading only --to meant a run that named
  // one fork put every card homecoming had ever moved back where it started, silently
  // reversing consolidations the user meant to keep. Matched against the card and
  // both ends of its move, which is every id the run that made it printed.
  if (opts.session?.length) {
    const named = opts.session;
    const matches = (card: RepointedCard): boolean =>
      named.some(
        (prefix) =>
          card.sessionId.startsWith(prefix) ||
          bareSessionId(card.sessionId).startsWith(prefix) ||
          card.from.startsWith(prefix) ||
          card.to.startsWith(prefix),
      );
    const hits = cards.filter(matches);
    if (hits.length === 0) {
      throw new Error(`No repointed card matches ${named.join(', ')}.`);
    }
    cards = hits;
  }

  // Same order as `unclaim`/`dates`/`sweep --undo-retitles`: the write (if
  // any) happens before `--json` is checked, so `--undo --yes --json` reports
  // what was actually put back rather than the bare card list a dry run would
  // show.
  if (opts.json && dryRun) {
    print(cards);
    return;
  }

  if (cards.length === 0) {
    if (opts.json) {
      print([]);
      return;
    }
    console.log('No cards are repointed — there is nothing to put back.');
    return;
  }

  // `dryRun` can still be true here (the text-mode preview) — only the
  // `opts.json && dryRun` combination returned above, before this call.
  const outcomes = repointCards(undoRequests(cards), { store, ledger, dryRun });

  // Same fix as the main consolidate path above: the write already happened
  // (this branch is only reached once `opts.json && dryRun` has returned
  // above), so `--restart` is run and folded into the JSON here too, instead
  // of being silently dropped by returning before `finish` below ever runs.
  if (opts.json) {
    const restart = await restartAround(store, Boolean(opts.restart), RESTART_COMMAND);
    print({ outcomes, restart });
    if (opts.restart && !restart.done) process.exitCode = 1;
    return;
  }

  for (const outcome of outcomes) console.log(repointLine(outcome));

  if (dryRun) {
    console.log(pc.bold(`\nDry run: ${outcomes.length} would be put back.`));
    console.log(pc.dim('Re-run with --yes to write, before the restart rather than after it.'));
    return;
  }

  const back = outcomes.filter((outcome) => outcome.status === 'repointed').length;
  console.log(pc.bold(`\n${back} put back, ${outcomes.length - back} not.`));
  await finish(store, Boolean(opts.restart));
}

/** Enough of a conversation id to recognise it, which is all these lines need. */
function shortConversation(id: string): string {
  return id.slice(0, 8);
}

function consolidationLines(entry: ConsolidationEntry): string[] {
  const tip = entry.fork.branches[0]!;
  const lines = [`${pc.green('+')} ${entry.title}  ${pc.dim(shortId(entry.account.accountUuid))}`];

  if (entry.repoint) {
    lines.push(
      `    ${pc.dim(shortId(entry.repoint.sessionId))}  ` +
        `${shortConversation(entry.repoint.from)} → ${pc.bold(shortConversation(entry.repoint.to))}`,
    );
  } else {
    lines.push(`    already on ${pc.bold(shortConversation(tip.cliSessionId))}`);
  }

  // The trade, on the line that proposes it. "Keeps 2802, hides 105" is the whole
  // decision, and printing only the first half would be an advertisement.
  const hides = entry.hides;
  lines.push(
    pc.dim(
      `    keeps ${tip.total} records` +
        (hides > 0
          ? `, hides ${hides} the other ${entry.fork.branches.length > 2 ? 'halves hold' : 'half holds'}`
          : ''),
    ),
  );

  if (entry.remove.length > 0) {
    lines.push(
      pc.dim(
        `    removes ${entry.remove.length} surplus cop${entry.remove.length === 1 ? 'y' : 'ies'}`,
      ),
    );
  }
  for (const kept of entry.keptApart) {
    lines.push(
      pc.yellow(
        `    leaves ${shortId(kept.sessionId)} on ${shortConversation(kept.cliSessionId)} — the app wrote that card`,
      ),
    );
  }

  return lines;
}

/**
 * A pair homecoming can see and must not touch.
 *
 * Both rows were written by the app, so neither is homecoming's to remove and the
 * one that would be kept is already where it should be. Printed with the reason
 * rather than counted as work, and told plainly whose the decision is.
 */
function appMadeLines(entry: ConsolidationEntry): string[] {
  return [
    `${pc.dim('·')} ${entry.title}  ${pc.dim(shortId(entry.account.accountUuid))}`,
    ...entry.keptApart.map((kept) =>
      pc.dim(`    also on ${shortConversation(kept.cliSessionId)} as ${shortId(kept.sessionId)}`),
    ),
    pc.dim(
      `    the app wrote both cards, so ${programName()} leaves them — delete the spare row there`,
    ),
  ];
}

function divergedLines(entry: ConsolidationEntry): string[] {
  const held = entry.fork.branches
    .map((branch) => `${shortConversation(branch.cliSessionId)} holds ${branch.only}`)
    .join(', ');
  const tip = entry.fork.branches[0]!;
  // Named after the test that actually stopped it. Offering --max-lost under a
  // fork the share test caught would send the reader to a flag that changes
  // nothing for it, however high they set it.
  const share = tip.total > 0 ? Math.round((entry.fork.lost / tip.total) * 100) : 100;
  const wayOut =
    entry.divergedBy === 'share'
      ? `    one row would hide ${entry.fork.lost} of them — ${share}% of the ${tip.total} that would stay, so --max-lost-share ${share} to do it anyway`
      : `    one row would hide ${entry.fork.lost} of them — --max-lost ${entry.fork.lost} to do it anyway`;
  return [
    `${pc.dim('·')} ${entry.title}  ${pc.dim(shortId(entry.account.accountUuid))}`,
    pc.dim(`    left alone: ${held} records no other half has`),
    pc.dim(wayOut),
  ];
}

function repointLine(outcome: RepointOutcome): string {
  const mark =
    outcome.status === 'repointed'
      ? pc.green('+')
      : outcome.status === 'failed'
        ? pc.red('!')
        : pc.dim('·');
  const where =
    outcome.from === undefined
      ? shortConversation(outcome.to)
      : `${shortConversation(outcome.from)} → ${shortConversation(outcome.to)}`;
  const detail = outcome.detail ? pc.dim(` (${outcome.detail})`) : '';
  return `  ${mark} ${outcome.title}  ${pc.dim(where)}${detail}`;
}

function consolidationJson(entry: ConsolidationEntry): Record<string, unknown> {
  return {
    account: entry.account,
    title: entry.title,
    status: entry.status,
    root: entry.fork.root,
    // Both numbers, because they answer different questions: `lost` is what the
    // fork holds outside its tip anywhere and is what --max-lost is measured
    // against; `hides` is what this account would stop showing.
    lost: entry.fork.lost,
    hides: entry.hides,
    branches: entry.fork.branches,
    repoint: entry.repoint
      ? {
          path: entry.repoint.path,
          from: entry.repoint.from,
          to: entry.repoint.to,
          native: entry.repoint.native,
        }
      : null,
    remove: entry.remove.map((fostering) => fostering.copySessionId),
    keptApart: entry.keptApart,
  };
}

/**
 * Two rows for one conversation, and who put them there.
 *
 * The distinction is the point: homecoming removes what homecoming wrote, and a pair the
 * app made is reported so it is not blamed on the wrong tool, and so nobody goes
 * looking for a foster command that would delete somebody else's file.
 */
function reportDuplicates(report: DuplicateReport): void {
  if (report.copies.length > 0) {
    const one = report.copies.length === 1;
    console.log(
      pc.yellow(
        `${report.copies.length} of them duplicate${one ? 's' : ''} a conversation this account already had.` +
          `\nRemove ${one ? 'it' : 'them'} with: ${programName()} return --duplicates`,
      ),
    );
  }
  if (report.branches.length > 0) {
    const one = report.branches.length === 1;
    console.log(
      pc.yellow(
        `${report.branches.length} of them ${one ? 'is a branch' : 'are branches'} of a conversation this account already had.` +
          '\nSame work, forked: each side holds turns the other never got, so read both before' +
          `\nchoosing. Remove ${one ? 'it' : 'them'} with: ${programName()} return --branches`,
      ),
    );
  }
  if (report.appMade > 0) {
    const one = report.appMade === 1;
    console.log(
      pc.dim(
        `${report.appMade} conversation${one ? '' : 's'} here ${one ? 'has' : 'have'} more than one card the app itself made.` +
          '\nfoster did not write those and will not remove them. Deleting one in the app is safe:' +
          '\nthe conversation is not in the card.',
      ),
    );
  }
}

/**
 * Shared tail of every write-then-optionally-restart command that has no
 * `--detach` of its own — `homecoming`, `restore`, `return`, `consolidate` and
 * `sweep --undo-retitles` — restart now, through the same
 * `restartAround` every `--detach`-capable command already shares, or say why
 * it matters.
 *
 * Used to call `restartDesktop` directly, which throws `DesktopControlError`
 * from inside a session Claude Desktop itself hosts. Every one of those
 * commands had already written by the time `finish()` ran, so the thrown
 * error reached `main()`'s generic handler and printed "Nothing was changed."
 * over writes that had, in fact, happened. `restartAround` never throws: it
 * reports what was written and hands over the command to finish the restart
 * from outside the app instead.
 */
async function finish(store: StoreLayout, restart: boolean): Promise<void> {
  if (!restart) {
    console.log(
      pc.dim('Restart Claude Desktop to see the change, or re-run with --restart to do it here.'),
    );
    return;
  }
  const outcome = await restartAround(store, true, RESTART_COMMAND);
  if (outcome.done) {
    console.log(pc.bold('Claude Desktop is up, with the sidebar rebuilt.'));
    return;
  }
  console.log(pc.yellow(outcome.reason ?? 'The restart did not finish.'));
  console.log(`  ${outcome.command}`);
  process.exitCode = 1;
}

const UNCLAIM_PREVIEW_LIMIT = 12;

program
  .command('unclaim')
  .helpGroup('After the sweep:')
  .description('release the worktree claim a copy already on disk inherited from its original')
  .option('--undo', 'put a released claim back, where nothing has moved on since')
  .option('--json', 'machine-readable output')
  .option('--yes', 'actually write; without it nothing is written')
  .addOption(new Option('--dry-run', 'show what would happen and write nothing').conflicts('yes'))
  .action(function (this: Command) {
    const { store, ledger } = context(this);
    const opts = this.opts<{ undo?: boolean; json?: boolean; yes?: boolean; dryRun?: boolean }>();
    const dryRun = opts.dryRun || !opts.yes;

    if (opts.undo) {
      undoUnclaimCommand(ledger, opts, dryRun);
      return;
    }

    // The reach decides where `cwd` lands, exactly as it does when a copy is
    // minted — so releasing a claim by hand never undoes the directory a
    // sweep chose for the fuller half of a conversation.
    const plan = planUnclaim(store, project(ledger.read()), { kin: lineage() });

    if (opts.json) {
      // Same order as `sweep`: the write (if any) happens before the JSON is
      // shaped, so `--yes --json` reports what was actually done rather than
      // degrading to a dry-run preview a scripted caller would mistake for
      // the real thing.
      if (dryRun) {
        print(plan);
      } else {
        const outcomes = applyUnclaim(plan.items, { ledger });
        print({ plan, outcomes });
      }
      return;
    }

    if (plan.items.length === 0) {
      console.log('No copy here still claims a worktree.');
      return;
    }

    const count = plan.items.length;
    console.log(
      pc.bold(
        `${count} cop${count === 1 ? 'y' : 'ies'} still claim${count === 1 ? 's' : ''} a worktree; ` +
          'releasing them opens each in its repository instead.',
      ),
    );
    const shown = plan.items.slice(0, UNCLAIM_PREVIEW_LIMIT);
    for (const item of shown) console.log(unclaimPlanLine(item));
    if (plan.items.length > shown.length) {
      console.log(pc.dim(`  … and ${plan.items.length - shown.length} more`));
    }

    if (dryRun) {
      console.log(pc.dim('\nRe-run with --yes to release them.'));
      return;
    }

    const outcomes = applyUnclaim(plan.items, { ledger });
    console.log('');
    for (const outcome of outcomes) console.log(unclaimOutcomeLine(outcome));

    const released = outcomes.filter((o) => o.status === 'released').length;
    const skipped = outcomes.filter((o) => o.status === 'skipped').length;
    const failed = outcomes.filter((o) => o.status === 'failed').length;
    console.log(pc.bold(`\n${released} released, ${skipped} skipped, ${failed} failed.`));
    console.log(
      pc.dim(
        "Like a retitle, this shows only at the app's next restart — restart Claude Desktop, " +
          `or run "${programName()} app restart". A card the app rewrites in the meantime keeps (or ` +
          `regains) its claim on disk, and the next "${programName()} unclaim" or sweep finds and ` +
          'releases it again.',
      ),
    );
    console.log(pc.dim(`Undo with: ${programName()} unclaim --undo --yes`));
  });

function undoUnclaimCommand(ledger: Ledger, opts: { json?: boolean }, dryRun: boolean): void {
  const pending = listWorktreeReleased(project(ledger.read()));

  if (opts.json && dryRun) {
    print(pending);
    return;
  }

  if (pending.length === 0 && !opts.json) {
    console.log('No worktree claim has been released — there is nothing to put back.');
    return;
  }

  // Same order as `sweep`: the write happens before `--json` is checked, so
  // `--undo --yes --json` reports what was actually put back rather than the
  // bare pending list a dry run would show.
  const outcomes = undoUnclaim({ ledger, dryRun });

  if (opts.json) {
    print(outcomes);
    return;
  }

  for (const outcome of outcomes) {
    const mark =
      outcome.status === 'undone'
        ? pc.green('+')
        : outcome.status === 'failed'
          ? pc.red('x')
          : pc.dim('·');
    const detail = outcome.detail ? pc.dim(` (${outcome.detail})`) : '';
    console.log(`  ${mark} ${shortId(outcome.sessionId)}${detail}`);
  }

  const back = outcomes.filter((outcome) => outcome.status === 'undone').length;
  if (dryRun) {
    console.log(pc.bold(`\nDry run: ${back} would be put back.`));
    console.log(pc.dim('Re-run with --yes to write.'));
    return;
  }
  console.log(pc.bold(`\n${back} put back, ${outcomes.length - back} not.`));
}

const DATES_PREVIEW_LIMIT = 12;

program
  .command('dates')
  .helpGroup('After the sweep:')
  .description(
    "advance a card's date to match its transcript's last answer, when the transcript is ahead",
  )
  .option('--undo', 'put an advanced date back to what the app had')
  .option('--json', 'machine-readable output')
  .option('--yes', 'actually write; without it nothing is written')
  .addOption(new Option('--dry-run', 'show what would happen and write nothing').conflicts('yes'))
  .action(function (this: Command) {
    const { store, ledger } = context(this);
    const opts = this.opts<{ undo?: boolean; json?: boolean; yes?: boolean; dryRun?: boolean }>();
    const dryRun = opts.dryRun || !opts.yes;

    if (opts.undo) {
      undoDatesCommand(ledger, opts, dryRun);
      return;
    }

    const { candidates, scanOf } = candidatesFromStore(store);
    const items = planDates(candidates, scanOf);
    const advancing = items.filter((item) => item.status === 'advance');

    if (opts.json) {
      // Same order as `sweep` and `unclaim`: the write (if any) happens before
      // the JSON is shaped, so `--yes --json` reports what was actually done
      // rather than degrading to a dry-run preview a scripted caller would
      // mistake for the real thing.
      if (dryRun) {
        print({ items });
      } else {
        const outcomes = dateCards(requestsFromPlan(items), { ledger });
        print({ items, outcomes });
      }
      return;
    }

    if (advancing.length === 0) {
      console.log('No card here is behind its own transcript.');
      return;
    }

    const count = advancing.length;
    console.log(
      pc.bold(
        `${count} card${count === 1 ? '' : 's'} ${count === 1 ? 'is' : 'are'} behind ` +
          `${count === 1 ? 'its' : 'their'} own transcript — the sidebar files ` +
          `${count === 1 ? 'it' : 'them'} by a date older than the work actually is.`,
      ),
    );
    const shown = advancing.slice(0, DATES_PREVIEW_LIMIT);
    for (const item of shown) console.log(datePlanLine(item));
    if (advancing.length > shown.length) {
      console.log(pc.dim(`  … and ${advancing.length - shown.length} more`));
    }

    if (dryRun) {
      console.log(pc.dim('\nRe-run with --yes to advance them.'));
      return;
    }

    const outcomes = dateCards(requestsFromPlan(items), { ledger });
    console.log('');
    for (const outcome of outcomes) console.log(dateOutcomeLine(outcome));

    const dated = outcomes.filter((o) => o.status === 'dated').length;
    const skipped = outcomes.filter((o) => o.status === 'skipped').length;
    const failed = outcomes.filter((o) => o.status === 'failed').length;
    console.log(pc.bold(`\n${dated} advanced, ${skipped} skipped, ${failed} failed.`));
    console.log(
      pc.dim(
        "Like a retitle, this shows only at the app's next restart — restart Claude Desktop, " +
          `or run "${programName()} app restart". A card the app rewrites in the meantime keeps (or ` +
          `regains) its own date, and the next "${programName()} dates" finds and advances it again.`,
      ),
    );
    console.log(pc.dim(`Undo with: ${programName()} dates --undo --yes`));
  });

function undoDatesCommand(ledger: Ledger, opts: { json?: boolean }, dryRun: boolean): void {
  const pending = listDated(project(ledger.read()));

  if (opts.json && dryRun) {
    print(pending);
    return;
  }

  if (pending.length === 0 && !opts.json) {
    console.log('No card has had its date advanced — there is nothing to put back.');
    return;
  }

  // Same order as `sweep`: the write happens before `--json` is checked, so
  // `--undo --yes --json` reports what was actually put back rather than the
  // bare pending list a dry run would show.
  const outcomes = dateCards(undoDateRequests(pending), { ledger, dryRun });

  if (opts.json) {
    print(outcomes);
    return;
  }

  for (const outcome of outcomes) {
    const mark =
      outcome.status === 'dated'
        ? pc.green('+')
        : outcome.status === 'failed'
          ? pc.red('x')
          : pc.dim('·');
    const detail = outcome.detail ? pc.dim(` (${outcome.detail})`) : '';
    console.log(`  ${mark} ${shortId(outcome.sessionId)}${detail}`);
  }

  const back = outcomes.filter((outcome) => outcome.status === 'dated').length;
  if (dryRun) {
    console.log(pc.bold(`\nDry run: ${back} would be put back.`));
    console.log(pc.dim('Re-run with --yes to write.'));
    return;
  }
  console.log(pc.bold(`\n${back} put back, ${outcomes.length - back} not.`));
}

const layoutCmd = program
  .command('layout')
  .helpGroup('After the sweep:')
  .summary('bring sidebar groups and routines into this account')
  .description(
    "Bring the sidebar's groups and its scheduled tasks (routines) from the\n" +
      'accounts you are leaving into the one signed in now, once — matched by\n' +
      'name for a group, by its own id for a routine, so bringing either twice\n' +
      'is a no-op rather than a duplicate.\n\n' +
      "A target card already filed in a group is left alone — it is the user's own\n" +
      'filing, and it wins. A routine the target already has, enabled or not, is left\n' +
      'alone too: it may have been disabled on purpose. A one-shot routine that is\n' +
      'already overdue is not brought at all — the app runs an overdue task at its next\n' +
      'launch, and a stale one firing unasked is worse than one left behind.\n\n' +
      "Both files are the app's own and it rewrites them from memory, so — like\n" +
      `"${programName()} pin" — a write here needs the app closed.`,
  )
  .option('--to <accountUuid>', 'write into this account instead')
  .option('--to-org <organizationUuid>', 'write into this organization')
  .option('--no-groups', 'skip the sidebar groups')
  .option('--no-routines', 'skip the scheduled tasks')
  .option('--no-view', "skip the sidebar filter menu's account settings")
  .option('--no-pins', 'skip the pin moves a sweep could not make with the app open')
  .option('--json', 'machine-readable output')
  .option(
    '--restart',
    'quit Claude Desktop, write, then start it again — the write happens in the gap',
  );
addDetachOptions(layoutCmd)
  .option('--yes', 'actually write; without it nothing is written')
  .addOption(new Option('--dry-run', 'show what would happen and write nothing').conflicts('yes'))
  .action(async function (this: Command) {
    const { store, ledger } = context(this);
    const opts = this.opts<{
      to?: string;
      toOrg?: string;
      groups: boolean;
      routines: boolean;
      view: boolean;
      pins: boolean;
      json?: boolean;
      restart?: boolean;
      detach?: boolean;
      detachDelay?: string;
      detachEvenWithLive?: boolean;
      yes?: boolean;
      dryRun?: boolean;
    }>();
    const dryRun = opts.dryRun || !opts.yes;
    checkDetachPrereqs({ detach: opts.detach, restart: opts.restart, dryRun });
    const detachDelay = parseDetachDelay(opts.detachDelay);
    if (typeof detachDelay !== 'number') throw new Error(detachDelay.error);
    const target = resolveDestination(store, listAccountDirs(store), opts);

    // Shared by the plan shown up front and the fresh re-plan `--restart` takes
    // inside the gap (see below) — both have to honour the same `--no-*` flags.
    const applyFlags = (p: LayoutPlan): LayoutPlan => {
      if (opts.groups === false) p.groups.items = [];
      if (opts.routines === false) p.routines = { ...p.routines, bring: [] };
      // Cleared to the same empty shape `planLayoutViewCarry` itself returns
      // when there is nothing to carry, so `--no-groups --no-routines
      // --no-view` leaves every count `applyLayout` checks at zero and appends
      // no ledger event — the same "wrote nothing, said nothing" rule the other
      // two flags already followed.
      if (opts.view === false) p.viewPrefs = { changes: [], account: {} };
      // Same shape planPinMoves returns with nothing pending, so the four
      // --no-* flags together still write nothing and append nothing.
      if (opts.pins === false) p.pins = { moves: [], settled: [] };
      return p;
    };

    // Read-only, taken once up front — never repeated inside the closed-app
    // gap `--restart` re-plans in below, where the Local Storage record would
    // already reflect whichever account is signed in *before* the restart,
    // not `target`. See `engine/view.ts`'s `recordSignedInViewSighting`.
    recordSignedInViewSighting(store, ledger);

    const plan = applyFlags(planLayout({ store, target, ledgerEvents: ledger.read() }));

    // A fact about the target's groups file as it stands right now, not about
    // what this run would bring — see `readGroupScopesReport`.
    const groupScopesSkipped = readGroupScopesReport(store).skippedEntries[scopeKey(target)] ?? 0;

    if (dryRun) {
      if (opts.json) {
        print({ target, dryRun: true, plan });
        return;
      }
      for (const line of layoutPlanLines(plan, { groupScopesSkipped })) console.log(line);
      console.log(pc.dim('\nRe-run with --yes to write.'));
      return;
    }

    // Built from the actual argv, not a template: a bare `'homecoming layout --yes
    // --restart'` dropped whatever `--store`/`--ledger`/`--to`/`--to-org` (or
    // `--no-*`) this run actually carried, so the line handed over on a
    // self-hosted refusal silently landed somewhere else, or applied
    // everything instead of the subset this run asked for.
    const restartCommand = restartCommandFromArgv(process.argv.slice(2));

    if (opts.detach) {
      // The write itself happens in the detached process, which re-runs this
      // exact invocation (minus the --detach* flags — `planDetached` strips
      // them) from outside the app. This process only shows the plan it read
      // and launches that; `--restart` re-plans fresh once the app is
      // actually closed, same as the in-process path below, because that is
      // the only plan that is ever real.
      //
      // Text only: `--json` prints the same plan inside the object below, and
      // printing these lines first as well would hand a scripted caller a
      // stream that is half plain text and half JSON.
      if (!opts.json) {
        for (const line of layoutPlanLines(plan, { groupScopesSkipped })) console.log(line);
      }
      const outcome = await runDetach(
        store,
        process.argv.slice(2),
        detachDelay,
        Boolean(opts.detachEvenWithLive),
      );
      if (opts.json) {
        print({ target, dryRun: false, plan, detach: detachJson(outcome) });
        if (!outcome.ok) process.exitCode = 1;
        return;
      }
      printDetachResult(outcome, false, detachNotNeededNote(store));
      return;
    }

    if (!opts.restart) {
      // Checked here rather than at the top, the same as `homecoming pin`: reading
      // and a dry run keep working while the app is up, and it is only the
      // write that cannot share the files with it.
      refuseIfAppRunning(store);

      // Caught here, not left to the top-level handler: that only ever had the
      // bare error message to show, with no plan around it and no distinction
      // between "wrote nothing" and "wrote three of five things, then failed".
      let result: ApplyLayoutResult | undefined;
      let failure: unknown;
      try {
        result = applyLayout(plan, { store, ledger });
      } catch (error) {
        failure = error;
      }

      if (opts.json) {
        print({
          target,
          dryRun: false,
          plan,
          result,
          ...(failure
            ? {
                error: failure instanceof Error ? failure.message : String(failure),
                written: writtenOf(failure),
              }
            : {}),
        });
        if (failure) process.exitCode = 1;
        return;
      }

      for (const line of layoutPlanLines(plan, { groupScopesSkipped })) console.log(line);
      if (result) {
        for (const line of layoutResultLines(result)) console.log(line);
        console.log(
          pc.dim(
            `\nInvisible until the app re-reads its files: restart Claude Desktop, or ${restartCommand}.`,
          ),
        );
      }
      if (failure) {
        for (const line of layoutFailureLines(failure)) console.log(line);
        process.exitCode = 1;
      }
      return;
    }

    let result: ApplyLayoutResult | undefined;
    let freshPlan: LayoutPlan | undefined;
    let writtenOnFailure: string[] | undefined;
    let writtenMtimeMs: number | undefined;
    const restart = await restartAround(store, true, restartCommand, async () => {
      // The plan above was made while the app was still running. Re-planned
      // fresh here, from disk, in the one window both files are safe to write
      // — a group, a routine or a filter-menu setting the app itself flushed
      // in the meantime would otherwise never make it into what actually gets
      // applied. It is this fresh plan, not the stale one shown above, that is
      // written.
      freshPlan = applyFlags(planLayout({ store, target, ledgerEvents: ledger.read() }));
      try {
        result = applyLayout(freshPlan, { store, ledger });
        // Taken before the app starts: any later mtime is the app's own
        // rewrite, which is what `verifyLayoutGroups` waits for.
        writtenMtimeMs = statSync(store.desktopConfigFile).mtimeMs;
      } catch (error) {
        // Captured here, ahead of the rethrow, because `restartAround` reports
        // failure as a string `reason` — the only way this action still gets
        // at what was written on its own is to have kept it before that
        // string was ever built.
        writtenOnFailure = writtenOf(error);
        throw error;
      }
    });

    // The write landing is not the end of it: measured 23/09/2026, the app
    // started, read the groups homecoming had written, and rewrote its config
    // without them three seconds later (the guide, "What the app trusts at
    // startup"). Whether that happened again is read back here, rather than
    // left for the user to find in the sidebar under "layout applied".
    let check: LayoutGroupsCheck | undefined;
    if (restart.done && result && result.assigned.length > 0 && writtenMtimeMs !== undefined) {
      check = await verifyLayoutGroups(store, target, result.assigned, { writtenMtimeMs });
    }
    const dropped = (check?.dropped.length ?? 0) > 0;

    if (opts.json) {
      print({
        target,
        dryRun: false,
        plan,
        freshPlan,
        result,
        restart,
        ...(check ? { check } : {}),
        ...(writtenOnFailure ? { written: writtenOnFailure } : {}),
      });
      if (!restart.done || dropped) process.exitCode = 1;
      return;
    }

    for (const line of layoutPlanLines(plan, { groupScopesSkipped })) console.log(line);
    if (
      freshPlan &&
      layoutPendingCountsChanged(pendingLayoutCounts(plan), pendingLayoutCounts(freshPlan))
    ) {
      console.log(
        pc.yellow('\nThe plan changed once the app closed — this is what was actually applied:'),
      );
      for (const line of layoutPlanLines(freshPlan)) console.log(line);
    }
    if (result) {
      for (const line of layoutResultLines(result)) console.log(line);
    } else if (writtenOnFailure && writtenOnFailure.length > 0) {
      console.log(pc.dim(`\nWritten before the failure: ${writtenOnFailure.join(', ')}`));
    }
    // `restartAround` never runs `duringGap` at all when the app could not be
    // quit, so `restart.done` is exactly the signal for whether the write
    // above happened — never say "applied" over a gap that never opened, or
    // one that opened and then threw. And never over groups the app dropped
    // once it was up again — `check` is what says so.
    if (check) {
      for (const line of layoutCheckLines(check)) console.log(line);
    }
    if (restart.done && dropped) {
      console.log(pc.yellow('\nClaude Desktop is up, but not with every group this run wrote.'));
      process.exitCode = 1;
    } else if (restart.done) {
      console.log(pc.bold('\nClaude Desktop is up, with the layout applied.'));
    } else {
      console.log(pc.yellow(`\n${restart.reason ?? 'The restart did not finish.'}`));
      console.log(`  ${restart.command}`);
      process.exitCode = 1;
    }
  });

const view = program
  .command('view')
  .helpGroup('After the sweep:')
  .summary("the Code sidebar's filter menu — show it, or change it")
  .description(
    'Seven settings, two stores: three live machine-wide in Local Storage, four live\n' +
      'per account in claude_desktop_config.json. Bare, this shows all seven, this\n' +
      "account's value for each, and where it lives.\n\n" +
      "Both files are the app's own and it rewrites them from memory, so — like\n" +
      `"${programName()} layout" — a write needs the app closed.`,
  )
  .option('--to <accountUuid>', 'read this account instead of the one signed in')
  .option('--json', 'machine-readable output')
  .action(function (this: Command) {
    const { store } = context(this);
    const opts = this.opts<{ to?: string; json?: boolean }>();
    const target = resolveDestination(store, listAccountDirs(store), opts);
    const state = readViewState(store, target);

    if (opts.json) {
      print({
        target,
        status: state.account.status ?? null,
        groupBy: state.groupBy ? (GROUP_BY_STORED_TO_WORD[state.groupBy] ?? state.groupBy) : null,
        sort: SORT_STORED_TO_WORD[state.sort] ?? state.sort,
        environments: state.account.environments?.map((v) => ENV_STORED_TO_WORD[v] ?? v) ?? [],
        showEmptyProjects: state.account.showEmptyProjects ?? null,
        showPrStatus: state.account.showPrStatus ?? true,
        activityDays: state.account.activityDays ?? null,
        legacy: state.legacy,
        unknownAccountKeys: state.unknownAccountKeys,
      });
      return;
    }

    console.log(pc.bold(`Sidebar filters for ${shortId(target.accountUuid)}`));
    // Whatever `readViewState`'s own reads (today, only the machine-wide Local
    // Storage record) noticed while getting here — a recovered log, a record
    // this build had to skip over — said before the settings themselves, since
    // it can bear on whether the seven below are trustworthy.
    for (const line of viewNoticeLines(state)) console.log(line);
    const row = (label: string, where: 'machine' | 'account', value: string): void =>
      console.log(`  ${label.padEnd(14)} ${value}  ${pc.dim(`(${where})`)}`);
    row('status', 'account', state.account.status ?? pc.dim('(never set)'));
    row(
      'group-by',
      'machine',
      state.groupBy
        ? (GROUP_BY_STORED_TO_WORD[state.groupBy] ?? state.groupBy)
        : pc.dim('(never set)'),
    );
    row('sort', 'machine', SORT_STORED_TO_WORD[state.sort] ?? state.sort);
    row(
      'env',
      'account',
      state.account.environments && state.account.environments.length > 0
        ? state.account.environments.map((v) => ENV_STORED_TO_WORD[v] ?? v).join(',')
        : 'all',
    );
    row('empty-groups', 'account', String(state.account.showEmptyProjects ?? false));
    row('pr-status', 'account', String(state.account.showPrStatus ?? true));
    row(
      'activity-days',
      'account',
      state.account.activityDays !== undefined
        ? String(state.account.activityDays)
        : pc.dim('(default)'),
    );

    if (state.legacy.length > 0) {
      console.log(
        pc.dim(
          `\n${state.legacy.length} legacy key(s) still on disk, unread by the app: ${state.legacy.join(', ')}`,
        ),
      );
    }
    if (state.unknownAccountKeys.length > 0) {
      console.log(
        pc.dim(
          `${state.unknownAccountKeys.length} unrecognised account-suffixed key(s) in ` +
            `epitaxyPrefs: ${state.unknownAccountKeys.join(', ')}`,
        ),
      );
    }
  });

const viewSetCmd = view
  .command('set')
  .summary('change one or more of the seven filters')
  .option('--status <value>', `${STATUS_WORDS.join('|')}`)
  .option('--group-by <value>', `${Object.keys(GROUP_BY_WORDS).join('|')}`)
  .option('--sort <value>', `${Object.keys(SORT_WORDS).join('|')}`)
  .option('--env <values>', `comma-separated ${Object.keys(ENV_WORDS).join(',')}, or "all"`)
  .option('--empty-groups <value>', 'on|off')
  .option('--pr-status <value>', 'on|off')
  .option('--activity-days <value>', '0|1|3|7|30')
  .option('--to <accountUuid>', 'write into this account instead')
  .option('--to-org <organizationUuid>', 'write into this organization')
  .option('--restart', 'quit Claude Desktop, write, then start it again');
addDetachOptions(viewSetCmd)
  .option('--json', 'machine-readable output')
  .option('--yes', 'actually write; without it nothing is written')
  .addOption(new Option('--dry-run', 'show what would happen and write nothing').conflicts('yes'))
  .action(async function (this: Command) {
    const { store } = context(this);
    // `optsWithGlobals`, not `opts`: the parent `view` command declares `--to`
    // and `--json` of its own (for the bare `homecoming view`), and Commander
    // resolves a flag against the first command in the chain that declares it
    // — here, the parent, silently, whichever side of `set` on the command
    // line it lands. `this.opts()` alone came back with neither `to` nor (once
    // `--json` was added here) `json` at all; `optsWithGlobals` merges every
    // ancestor's own opts in, so the flag reaches this action no matter which
    // level actually parsed it.
    const opts = this.optsWithGlobals<{
      status?: string;
      groupBy?: string;
      sort?: string;
      env?: string;
      emptyGroups?: string;
      prStatus?: string;
      activityDays?: string;
      to?: string;
      toOrg?: string;
      restart?: boolean;
      detach?: boolean;
      detachDelay?: string;
      detachEvenWithLive?: boolean;
      json?: boolean;
      yes?: boolean;
      dryRun?: boolean;
    }>();
    const dryRun = opts.dryRun || !opts.yes;
    checkDetachPrereqs({ detach: opts.detach, restart: opts.restart, dryRun });
    const detachDelay = parseDetachDelay(opts.detachDelay);
    if (typeof detachDelay !== 'number') throw new Error(detachDelay.error);
    const target = resolveDestination(store, listAccountDirs(store), opts);
    const request = parseViewSetRequest(opts);
    const plan = planViewSet(store, target, request);

    if (plan.changes.length === 0) {
      if (opts.json) {
        print({ target, dryRun, plan });
        return;
      }
      console.log('Nothing to change.');
      return;
    }

    if (dryRun) {
      if (opts.json) {
        print({ target, dryRun: true, plan });
        return;
      }
      printViewChanges(plan.changes, plan.impliedStatusActive);
      console.log(pc.dim('\nRe-run with --yes to write.'));
      return;
    }

    // Built from the actual argv, not a template: a bare `'homecoming view set
    // --yes --restart'` dropped every filter flag this run actually carried,
    // so the command handed over on a self-hosted refusal said "Nothing to
    // change." — measured 24/09/2026.
    const restartCommand = restartCommandFromArgv(process.argv.slice(2));

    if (opts.detach) {
      // Same split as `homecoming layout`: this process only shows the plan and
      // launches the detached one, which re-runs the identical invocation
      // (minus --detach*) from outside the app and does the write itself,
      // re-planned fresh once the app is actually closed.
      if (!opts.json) printViewChanges(plan.changes, plan.impliedStatusActive);
      const outcome = await runDetach(
        store,
        process.argv.slice(2),
        detachDelay,
        Boolean(opts.detachEvenWithLive),
      );
      if (opts.json) {
        print({
          target,
          dryRun: false,
          plan,
          detach:
            outcome.ok && outcome.plan && outcome.launch
              ? {
                  detached: true,
                  pid: outcome.launch.pid,
                  via: outcome.launch.via,
                  log: outcome.plan.logPath,
                  vbs: outcome.plan.vbsPath,
                  delaySeconds: outcome.plan.delaySeconds,
                  argv: outcome.plan.argv,
                  ...(outcome.ending ? { ending: outcome.ending } : {}),
                }
              : { detached: false, error: outcome.reason },
        });
        if (!outcome.ok) process.exitCode = 1;
        return;
      }
      printDetachResult(outcome, false, detachNotNeededNote(store));
      return;
    }

    if (!opts.restart) {
      refuseIfAppRunning(store);
      applyViewSet(plan, { store });
      if (opts.json) {
        print({ target, dryRun: false, plan });
        return;
      }
      printViewChanges(plan.changes, plan.impliedStatusActive);
      console.log(pc.bold('\nWritten.'));
      console.log(
        pc.dim('Invisible until the app re-reads its files: restart Claude Desktop, or --restart.'),
      );
      return;
    }

    // The plan above was made with the app still running; re-planned fresh
    // inside the gap, from disk, and it is that fresh plan — not the stale one
    // shown above — that gets written. See the same fix on `homecoming layout`.
    let freshPlan: ViewSetPlan | undefined;
    const restart = await restartAround(store, true, restartCommand, async () => {
      freshPlan = planViewSet(store, target, request);
      if (freshPlan.changes.length > 0) applyViewSet(freshPlan, { store });
    });

    if (opts.json) {
      print({ target, dryRun: false, plan, freshPlan, restart });
      if (!restart.done) process.exitCode = 1;
      return;
    }

    printViewChanges(plan.changes, plan.impliedStatusActive);
    if (restart.done) {
      if (freshPlan && JSON.stringify(freshPlan.changes) !== JSON.stringify(plan.changes)) {
        console.log(
          pc.yellow('\nThe plan changed once the app closed — this is what was applied:'),
        );
        printViewChanges(freshPlan.changes, freshPlan.impliedStatusActive);
      }
      console.log(pc.bold('\nClaude Desktop is up, with the filters applied.'));
    } else {
      console.log(pc.yellow(`\n${restart.reason ?? 'The restart did not finish.'}`));
      console.log(`  ${restart.command}`);
      process.exitCode = 1;
    }
  });

const viewCopyCmd = view
  .command('copy')
  .summary("copy another account's per-account filters (env, empty groups, PR status)")
  .requiredOption('--from <accountUuid>', 'the account to copy from')
  .option('--to <accountUuid>', 'write into this account instead')
  .option('--to-org <organizationUuid>', 'write into this organization')
  .option('--restart', 'quit Claude Desktop, write, then start it again');
addDetachOptions(viewCopyCmd)
  .option('--json', 'machine-readable output')
  .option('--yes', 'actually write; without it nothing is written')
  .addOption(new Option('--dry-run', 'show what would happen and write nothing').conflicts('yes'))
  .action(async function (this: Command) {
    const { store } = context(this);
    // `optsWithGlobals`, not `opts` — same reason as `view set` above: the
    // parent `view` command's own `--to` and `--json` otherwise claim the
    // flag before it ever reaches this action.
    const opts = this.optsWithGlobals<{
      from: string;
      to?: string;
      toOrg?: string;
      restart?: boolean;
      detach?: boolean;
      detachDelay?: string;
      detachEvenWithLive?: boolean;
      json?: boolean;
      yes?: boolean;
      dryRun?: boolean;
    }>();
    const dryRun = opts.dryRun || !opts.yes;
    checkDetachPrereqs({ detach: opts.detach, restart: opts.restart, dryRun });
    const detachDelay = parseDetachDelay(opts.detachDelay);
    if (typeof detachDelay !== 'number') throw new Error(detachDelay.error);
    const accounts = listAccountDirs(store);
    const from = resolveSources(accounts, opts.from, undefined, {
      account: '--from',
      organization: '--from-org',
    })[0];
    if (!from) throw new Error(`No account here matches --from "${opts.from}".`);
    const to = resolveDestination(store, accounts, opts);

    const plan: ViewCopyPlan = planViewCopy(store, from, to);
    if (plan.changes.length === 0) {
      if (opts.json) {
        print({ from, to, dryRun, plan });
        return;
      }
      console.log('Nothing to copy: already the same.');
      return;
    }

    if (dryRun) {
      if (opts.json) {
        print({ from, to, dryRun: true, plan });
        return;
      }
      printViewChanges(plan.changes, false);
      console.log(pc.dim('\nRe-run with --yes to write.'));
      return;
    }

    const restartCommand = viewCopyRestartCommand(from, to);
    if (opts.detach) {
      if (!opts.json) printViewChanges(plan.changes, false);
      const outcome = await runDetach(
        store,
        process.argv.slice(2),
        detachDelay,
        Boolean(opts.detachEvenWithLive),
      );
      if (opts.json) {
        print({
          from,
          to,
          dryRun: false,
          plan,
          detach:
            outcome.ok && outcome.plan && outcome.launch
              ? {
                  detached: true,
                  pid: outcome.launch.pid,
                  via: outcome.launch.via,
                  log: outcome.plan.logPath,
                  vbs: outcome.plan.vbsPath,
                  delaySeconds: outcome.plan.delaySeconds,
                  argv: outcome.plan.argv,
                  ...(outcome.ending ? { ending: outcome.ending } : {}),
                }
              : { detached: false, error: outcome.reason },
        });
        if (!outcome.ok) process.exitCode = 1;
        return;
      }
      printDetachResult(outcome, false, detachNotNeededNote(store));
      return;
    }
    if (!opts.restart) {
      refuseIfAppRunning(store);
      applyViewCopy(plan, { store });
      if (opts.json) {
        print({ from, to, dryRun: false, plan });
        return;
      }
      printViewChanges(plan.changes, false);
      console.log(pc.bold('\nWritten.'));
      return;
    }

    // Same fix as `view set` above: re-planned fresh inside the gap rather than
    // applying the plan made while the app was still running.
    let freshPlan: ViewCopyPlan | undefined;
    const restart = await restartAround(store, true, restartCommand, async () => {
      freshPlan = planViewCopy(store, from, to);
      if (freshPlan.changes.length > 0) applyViewCopy(freshPlan, { store });
    });

    if (opts.json) {
      print({ from, to, dryRun: false, plan, freshPlan, restart });
      if (!restart.done) process.exitCode = 1;
      return;
    }

    printViewChanges(plan.changes, false);
    if (restart.done) {
      if (freshPlan && JSON.stringify(freshPlan.changes) !== JSON.stringify(plan.changes)) {
        console.log(pc.yellow('\nThe plan changed once the app closed — this is what was copied:'));
        printViewChanges(freshPlan.changes, false);
      }
      console.log(pc.bold('\nClaude Desktop is up, with the filters copied.'));
    } else {
      console.log(pc.yellow(`\n${restart.reason ?? 'The restart did not finish.'}`));
      console.log(`  ${restart.command}`);
      process.exitCode = 1;
    }
  });

function parseViewSetRequest(opts: {
  status?: string;
  groupBy?: string;
  sort?: string;
  env?: string;
  emptyGroups?: string;
  prStatus?: string;
  activityDays?: string;
}): ViewSetRequest {
  const onOff = (name: string, value: string | undefined): boolean | undefined => {
    if (value === undefined) return undefined;
    if (value === 'on') return true;
    if (value === 'off') return false;
    throw new Error(`--${name} expects on or off, got "${value}"`);
  };

  if (opts.status !== undefined && !(STATUS_WORDS as readonly string[]).includes(opts.status)) {
    throw new Error(`--status expects one of: ${STATUS_WORDS.join(', ')}`);
  }
  if (opts.groupBy !== undefined && !(opts.groupBy in GROUP_BY_WORDS)) {
    throw new Error(`--group-by expects one of: ${Object.keys(GROUP_BY_WORDS).join(', ')}`);
  }
  if (opts.sort !== undefined && !(opts.sort in SORT_WORDS)) {
    throw new Error(`--sort expects one of: ${Object.keys(SORT_WORDS).join(', ')}`);
  }
  let env: ViewSetRequest['env'];
  if (opts.env !== undefined) {
    if (opts.env === 'all') env = 'all';
    else {
      const words = opts.env.split(',').map((w) => w.trim());
      for (const word of words) {
        if (!(word in ENV_WORDS)) {
          throw new Error(
            `--env expects a comma-separated list of ${Object.keys(ENV_WORDS).join(',')}, or "all"`,
          );
        }
      }
      env = words as ViewSetRequest['env'];
    }
  }
  let activityDays: ViewSetRequest['activityDays'];
  if (opts.activityDays !== undefined) {
    const n = Number(opts.activityDays);
    if (![0, 1, 3, 7, 30].includes(n))
      throw new Error('--activity-days expects one of: 0, 1, 3, 7, 30');
    activityDays = n as ViewSetRequest['activityDays'];
  }

  return {
    ...(opts.status !== undefined ? { status: opts.status as StatusWord } : {}),
    ...(opts.groupBy !== undefined ? { groupBy: opts.groupBy as ViewSetRequest['groupBy'] } : {}),
    ...(opts.sort !== undefined ? { sort: opts.sort as ViewSetRequest['sort'] } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(onOff('empty-groups', opts.emptyGroups) !== undefined
      ? { emptyGroups: onOff('empty-groups', opts.emptyGroups) }
      : {}),
    ...(onOff('pr-status', opts.prStatus) !== undefined
      ? { prStatus: onOff('pr-status', opts.prStatus) }
      : {}),
    ...(activityDays !== undefined ? { activityDays } : {}),
  };
}

function printViewChanges(changes: ViewChange[], impliedStatusActive: boolean): void {
  for (const change of changes) {
    console.log(
      `  ${change.field}: ${pc.dim(String(change.from))} ${pc.dim('->')} ${String(change.to)}`,
    );
  }
  if (impliedStatusActive) {
    console.log(pc.dim('  (group-by state also sets status to active — the app requires it)'));
  }
}

program
  .command('status')
  .helpGroup('After the sweep:')
  .description('what is currently fostered')
  .option('--all', 'list every copy instead of summarising by account')
  .option('--to <accountUuid>', 'only copies written into this account')
  .option('--json', 'machine-readable output')
  .action(function (this: Command) {
    const { store, ledger } = context(this);
    const opts = this.opts<{ all?: boolean; to?: string; json?: boolean }>();
    let active = listActive(project(ledger.read()));
    if (opts.to !== undefined) active = selectByTarget(active, opts.to, undefined);

    if (opts.json) {
      print(
        active.map((f) => ({
          originSessionId: f.originSessionId,
          copySessionId: f.copySessionId,
          copyPath: f.copyPath,
          store: storeRootOfCopy(f.copyPath),
          cliSessionId: f.cliSessionId ?? null,
          originalTitle: f.originalTitle ?? null,
          origin: f.origin,
          target: f.target,
          fosteredAt: f.fosteredAt,
        })),
      );
      return;
    }

    if (active.length === 0) {
      console.log('Nothing is fostered.');
      return;
    }

    // The ledger spans every installation, so with two profiles in play the list
    // silently mixed them: a copy sitting in the other profile read exactly like
    // one in the store being worked on. Only said when it is true of the run.
    const { elsewhere } = partitionByStore(active, store);
    // Marked here for the same reason it is said after a return: the row in the
    // original account still carries the date it had the day it was fostered.
    const continued = new Set(continuedSince(store, active).map((c) => c.fostering.copySessionId));

    // Summary first, list on request. "What has foster done?" is a question
    // about shape — how many, and where — and answering it with one line per
    // copy stopped answering it at all: on this machine that was 1262 lines,
    // and finding out which account they were in meant piping the JSON through
    // a script. The per-copy list is still here, one flag away.
    if (!opts.all) {
      const labels = labelsOf(ledger);
      for (const line of whereCopiesAre(active).split('\n')) {
        const uuid = line.trim().split(/\s+/)[0]!;
        const name = labels.get(uuid);
        console.log(name ? `${line}  ${pc.dim(name)}` : line);
      }
      console.log(pc.bold(`\n${active.length} active fostering(s)`));
      console.log(
        pc.dim(`${programName()} status --all lists them; --to <accountUuid> narrows to one.`),
      );
      reportDuplicates(findDuplicates(store, active));
      if (elsewhere.length > 0) {
        console.log(
          pc.dim(
            `${elsewhere.length} of them ${elsewhere.length === 1 ? 'is' : 'are'} in another installation — return needs --all-stores, or --store on that one.`,
          ),
        );
      }
      console.log(pc.dim(`Ledger: ${ledger.path}`));
      return;
    }

    for (const fostering of active) {
      const carried = continued.has(fostering.copySessionId) ? pc.dim(' (continued since)') : '';
      const where = elsewhere.includes(fostering)
        ? pc.dim(` in ${storeRootOfCopy(fostering.copyPath)}`)
        : '';
      console.log(
        `  ${pc.dim(formatDate(fostering.fosteredAt))}  ${fostering.originalTitle ?? shortId(fostering.originSessionId)}  ${pc.dim(`from ${shortId(fostering.origin.accountUuid)}`)}${carried}${where}`,
      );
    }
    console.log(pc.bold(`\n${active.length} active fostering(s)`));
    reportDuplicates(findDuplicates(store, active));
    if (elsewhere.length > 0) {
      console.log(
        pc.dim(
          `${elsewhere.length} of them ${elsewhere.length === 1 ? 'is' : 'are'} in another installation — return needs --all-stores, or --store on that one.`,
        ),
      );
    }
    console.log(pc.dim(`Ledger: ${ledger.path}`));
  });

program
  .command('label')
  .helpGroup('Accounts:')
  .description('give an account a human name — the one in use, or any you name')
  .argument('[accountUuid]', 'the account to name; omit it for the one you are signed into')
  .argument('[label]')
  .option('--from-cache', 'name the signed-in account with its cached name and email')
  .option('--clear', 'drop the name you gave an account')
  .action(function (this: Command, first?: string, second?: string) {
    const { store, ledger } = context(this);
    const accounts = listAccountDirs(store);
    const currentAccountUuid = readConfig(store).lastKnownAccountUuid;

    // The name goes; whatever else names the account (its cached e-mail, for
    // the one signed in) takes over.
    if (this.opts<{ clear?: boolean }>().clear) {
      if (second !== undefined) throw new Error('--clear drops a name; it does not take one.');
      // A prefix is what people have in front of them — every screen prints the
      // abbreviation, so asking for the whole uuid here would mean copying one
      // out of a listing to undo what a listing showed.
      const accountUuid = first
        ? resolveAccountPrefix(
            first,
            accounts.map((ref) => ref.accountUuid),
          )
        : currentAccountUuid;
      if (!accountUuid) {
        throw new Error(
          'No account is recorded as signed in, so there is nothing to clear.\n' +
            `Name the account outright: ${programName()} label <accountUuid> --clear.`,
        );
      }
      const had = project(ledger.read()).labels.get(accountUuid);
      if (had === undefined) {
        console.log(`${shortId(accountUuid)} has no name of its own to clear.`);
        return;
      }
      ledger.append({ kind: 'account_labelled', accountUuid, label: '' });
      const now = labelsOf(ledger).get(accountUuid);
      console.log(`Cleared ${pc.bold(had)} from ${shortId(accountUuid)}.`);
      console.log(
        pc.dim(now ? `It goes by ${now} now.` : 'Nothing else names it, so it goes by its uuid.'),
      );
      return;
    }

    // --from-cache is the one-step version of `whoami` then `label`: read the
    // signed-in account's identity from the app's cache and use it as the name.
    if (this.opts<{ fromCache?: boolean }>().fromCache) {
      if (first !== undefined) {
        throw new Error('--from-cache names the signed-in account; do not also pass one.');
      }
      if (!currentAccountUuid) {
        throw new Error('No account is signed in, so there is nothing to read a name for.');
      }
      // The same read `whoami` uses, so the two never disagree: the app's cache,
      // completed by any identity reader or source a plugin registered.
      const identity = identityOf(store, currentAccountUuid, ledger);
      const fromCache = identityLabel(identity);
      if (!fromCache) {
        throw new Error(
          "Nothing is known about this account — the app's cache holds no profile for it.\n" +
            `Name it by hand instead: ${programName()} label "a name".`,
        );
      }
      ledger.append({
        kind: 'account_labelled',
        accountUuid: currentAccountUuid,
        label: fromCache,
      });
      console.log(`Labelled ${shortId(currentAccountUuid)} as ${pc.bold(fromCache)}.`);
      console.log(pc.dim("Read from the app's cache — not over the network."));
      return;
    }

    const { accountUuid, label } = applyLabel(
      ledger,
      first,
      second,
      accounts.map((ref) => ref.accountUuid),
      currentAccountUuid,
    );
    console.log(`Labelled ${shortId(accountUuid)} as ${pc.bold(label)}.`);
    // The pairing homecoming cannot make for itself is the one the app is showing on
    // screen: the email lives in the OAuth token cache, which homecoming does not read.
    if (first !== undefined && second === undefined) {
      console.log(pc.dim('That is the account the sidebar is reading right now.'));
    }
  });

program
  .command('whoami')
  .helpGroup('Accounts:')
  .description("the signed-in account's name and email, read from the app's own cache")
  .option('--json', 'machine-readable output')
  .action(function (this: Command) {
    const { store, ledger } = context(this);
    const accountUuid = readConfig(store).lastKnownAccountUuid;
    const json = this.opts<{ json?: boolean }>().json;

    if (!accountUuid) {
      if (json) {
        return print({ accountUuid: null, email: null, name: null });
      }
      console.log('No account is signed in. Open Claude Desktop once first.');
      return;
    }

    // Printed before the cache read, so this command always says something even
    // if the read below finds nothing — the account is the one fact that never
    // depends on the cache.
    if (!json) console.log(`account  ${accountUuid}`);

    // Read at rest, never over the network: the app cached its own profile in the
    // web-origin LevelDB, which is page data rather than a credential. Identity
    // readers a plugin registered complete that read, and an identity source
    // answers for what the cache no longer holds. The core has neither, so
    // without a plugin the JSON is the same three keys; `remembered` and
    // `seenAt` appear only when a source answered for what the cache lacked.
    const identity = identityOf(store, accountUuid, ledger);

    if (json) {
      return print({
        accountUuid,
        email: identity?.email ?? null,
        name: identity?.name ?? null,
        ...(identity?.remembered ? { remembered: true, seenAt: identity.seenAt ?? null } : {}),
      });
    }

    if (identity?.name) console.log(`name     ${pc.bold(identity.name)}`);
    if (identity?.email) console.log(`email    ${identity.email}`);
    if (identity?.remembered && identity.seenAt !== undefined) {
      console.log(pc.dim(`Not in the app's cache now; last seen ${formatDate(identity.seenAt)}.`));
    }
    if (!identity?.email && !identity?.name) {
      console.log(
        pc.dim(
          "Nothing found in the app's cache for this account.\n" +
            'The profile may be stored differently in this app version. You can still name it by hand:\n' +
            `  ${programName()} label "a name"`,
        ),
      );
      return;
    }
    console.log(
      pc.dim(`\nName the account with this in one step:  ${programName()} label --from-cache`),
    );
  });

const cacheCommand = program
  .command('cache')
  .helpGroup('After the sweep:')
  .description('the persistent scan cache under <FOSTER_HOME>/cache');

cacheCommand
  .command('clear')
  .summary('delete the persistent scan cache')
  .description(
    `Remove every file under the persistent cache ${programName()} keeps to skip re-reading\n` +
      'cards and transcripts that have not changed since the last run.\n\n' +
      'Nothing here is a record of anything — the next scan simply reads from disk\n' +
      'again and rebuilds it, the same as an entry `--no-cache` or a version mismatch\n' +
      'already ignores.',
  )
  .option('--json', 'machine-readable output')
  .action(function (this: Command) {
    const opts = this.opts<{ json?: boolean }>();
    const dir = defaultCacheDir(process.env);
    const removed = clearCache(dir);
    if (opts.json) {
      print({ dir, removed });
      return;
    }
    console.log(`Removed ${removed} file${removed === 1 ? '' : 's'} from ${dir}.`);
  });

program
  .command('labels')
  .helpGroup('Accounts:')
  .description('the name each account goes by — a label you gave, or the e-mail it answered with')
  .action(function (this: Command) {
    const { ledger } = context(this);
    const names = labelsOf(ledger);
    const manual = manualLabelsOf(ledger);
    if (names.size === 0) {
      console.log('No account has a name yet.');
      console.log(
        pc.dim(
          `${programName()} label names one by hand; the signed-in one is named from its cached e-mail.`,
        ),
      );
      return;
    }
    // The e-mail is dimmed, the chosen label is not: both name the account, but
    // only one of them was somebody's decision.
    for (const [accountUuid, name] of names) {
      console.log(`  ${shortId(accountUuid)}  ${manual.has(accountUuid) ? name : pc.dim(name)}`);
    }
  });

program
  .command('pin')
  .helpGroup('After the sweep:')
  .summary('pin sessions in the sidebar, or see what is pinned')
  .description(
    'Pin or unpin sessions in the Claude Desktop sidebar.\n\n' +
      'Pinning is not part of a session file. The app keeps it in its own ' +
      `IndexedDB, keyed on the session id — and ${programName()} mints a fresh id for ` +
      'every copy, so a copy of a pinned session always arrives unpinned. That is ' +
      'the gap this closes.\n\n' +
      'The database belongs to the app and is locked while it runs, so Claude ' +
      'Desktop has to be closed. A copy of it is taken before anything is written.',
  )
  .option('--session <id...>', 'sessions to pin, by id or unique prefix')
  .option('--remove', 'unpin them instead')
  .option(
    '--clear-all',
    'empty the whole pin list, every account; with the app open, queued for the next layout --restart',
  )
  .option('--backup-dir <path>', 'where to copy the database before writing')
  .option('--start', 'start Claude Desktop afterwards')
  .option('--yes', 'actually write; without it nothing is written')
  .addOption(new Option('--dry-run', 'show what would happen and write nothing').conflicts('yes'))
  .action(async function (this: Command) {
    const { store, ledger } = context(this);
    const opts = this.opts<{
      session?: string[];
      remove?: boolean;
      clearAll?: boolean;
      backupDir?: string;
      start?: boolean;
      yes?: boolean;
      dryRun?: boolean;
    }>();

    const state = readPinState(store);
    if (!state) {
      console.log('Nothing has ever been pinned in this installation.');
      console.log(
        pc.dim(
          `${programName()} copies the record the app writes rather than inventing one, because that record\n` +
            'carries a serialiser version it has no business guessing. Pin any session in the\n' +
            `sidebar once, and ${programName()} can do the rest from then on.`,
        ),
      );
      return;
    }

    if (state.notices.length > 0) {
      for (const note of state.notices) {
        console.log(pc.yellow(`warning: ${note}`));
      }
    }

    // A fresh start: every pin, every account's. Pin parity (`homecoming layout`) only ever copies a
    // pin some other account still has, so emptying the one shared list is what keeps an old pin
    // from being brought back by the next layout run.
    if (opts.clearAll) {
      if (opts.dryRun || !opts.yes) {
        console.log(
          pc.bold(`Dry run: all ${state.ids.length} pin(s) would be removed, every account's.`),
        );
        console.log(pc.dim('Re-run with --yes to write.'));
        return;
      }
      const running = inspectApp(store);
      if (running.running) {
        ledger.append({ kind: 'pins_clear_deferred' });
        console.log(
          `Claude Desktop is running, so its pin list cannot be written now. Queued: the next\n` +
            `"${programName()} layout --yes --restart" empties all ${state.ids.length} pin(s) while the app is closed.`,
        );
        return;
      }
      const backup = backupPinState(
        store,
        opts.backupDir ??
          path.join(path.dirname(ledger.path), 'backups', `pin-state-${Date.now()}`),
      );
      writePinState(state, []);
      ledger.append({ kind: 'pins_cleared', removed: state.ids.length });
      console.log(pc.dim(`Database copied to ${backup}`));
      console.log(pc.bold(`All ${state.ids.length} pin(s) removed.`));
      return;
    }

    const onDisk = new Map(scanStore(store).map((found) => [found.data.sessionId, found]));

    if (!opts.session?.length) {
      console.log(`${state.ids.length} pinned in ${store.root}:`);
      for (const id of state.ids) {
        const found = onDisk.get(id);
        const title =
          found?.data.title ?? pc.dim('(no session file — pinned id points at nothing)');
        console.log(`  ${shortId(id)}  ${title}`);
      }
      console.log(pc.dim(`\nRead from ${state.logPath}`));
      return;
    }

    const wanted = opts.remove
      ? selectPinnedIds(state.ids, opts.session)
      : selectByIds([...onDisk.values()], opts.session);
    const selected = opts.remove
      ? (wanted as { selected: string[] }).selected
      : (wanted as { selected: DiscoveredSession[] }).selected.map((found) => found.data.sessionId);

    if (wanted.unmatched.length > 0) {
      throw new Error(
        `No ${opts.remove ? 'pinned session' : 'session'} matches --session ${wanted.unmatched.join(', ')}.\n` +
          `Run "${programName()} pin" with no arguments to see what is there.`,
      );
    }

    // Pinning reaches across the whole store, but the sidebar does not: the app
    // loads one account's directory and marks what it finds there, so an id from
    // any other account joins the list and is never drawn. Refusing is the only
    // honest answer — writing it would report a pin that cannot appear, and the
    // ids of other accounts are exactly what "homecoming list" puts in front of you.
    if (!opts.remove) {
      const sidebar = currentAccount(store, listAccountDirs(store));
      const elsewhere = (wanted as { selected: DiscoveredSession[] }).selected.filter(
        (found) =>
          sidebar &&
          (found.account.accountUuid !== sidebar.accountUuid ||
            found.account.organizationUuid !== sidebar.organizationUuid),
      );
      if (elsewhere.length > 0) {
        const names = elsewhere
          .map((found) => `  ${shortId(found.data.sessionId)}  ${found.data.title ?? ''}`)
          .join('\n');
        throw new Error(
          `${elsewhere.length} of those ${elsewhere.length === 1 ? 'sessions belongs' : 'sessions belong'} to another account, which the sidebar never shows:\n${names}\n` +
            'Foster them into the account in use first, then pin the copies.',
        );
      }
    }

    // The app appends on toggle, so appending is what keeps homecoming's writes
    // indistinguishable from the sidebar's own.
    const next = opts.remove
      ? state.ids.filter((id) => !selected.includes(id))
      : [...state.ids, ...selected.filter((id) => !state.ids.includes(id))];

    if (next.length === state.ids.length) {
      console.log(
        opts.remove
          ? 'Nothing to do: none of those are pinned.'
          : 'Nothing to do: all of those are already pinned.',
      );
      return;
    }

    const verb = opts.remove ? 'unpin' : 'pin';
    for (const id of selected) {
      if (opts.remove ? state.ids.includes(id) : !state.ids.includes(id)) {
        console.log(`${verb} ${shortId(id)}  ${onDisk.get(id)?.data.title ?? ''}`);
      }
    }

    if (opts.dryRun || !opts.yes) {
      console.log(pc.bold(`\nDry run: ${state.ids.length} pinned would become ${next.length}.`));
      console.log(pc.dim('Re-run with --yes to write.'));
      return;
    }

    // Checked here rather than at the top so that reading and dry runs keep
    // working while the app is up — it is only the write that cannot share the
    // database, because LevelDB holds unflushed writes in memory and would put
    // them over the top of homecoming's.
    const app = inspectApp(store);
    if (app.running) {
      throw new Error(
        `Claude Desktop is running (${app.evidence.join('; ')}).\n` +
          'Its IndexedDB is locked and holds writes that are not on disk yet, so changing the\n' +
          'pin list now would be overwritten the moment it flushes. Close it first — ' +
          `"${programName()} app quit --terminate" will.`,
      );
    }

    const backup = backupPinState(
      store,
      opts.backupDir ?? path.join(path.dirname(ledger.path), 'backups', `pin-state-${Date.now()}`),
    );
    console.log(pc.dim(`Database copied to ${backup}`));

    writePinState(state, next);
    console.log(pc.bold(`\n${state.ids.length} pinned is now ${next.length}.`));

    if (opts.start) {
      const started = await startDesktop(store);
      console.log(
        started ? 'Claude Desktop is up.' : 'Started it; it has not taken the store yet.',
      );
    }
  });

/** The removal counterpart of selectByIds, matching against the pin list itself. */
function selectPinnedIds(
  pinned: string[],
  wanted: string[],
): { selected: string[]; unmatched: string[] } {
  const selected = new Set<string>();
  const unmatched: string[] = [];

  for (const id of wanted) {
    const needle = bareSessionId(id).toLowerCase();
    // Matched against what is pinned rather than what is on disk, so an id left
    // behind by a session that no longer exists can still be taken off the list.
    const matches = pinned.filter((candidate) =>
      bareSessionId(candidate).toLowerCase().startsWith(needle),
    );
    if (matches.length === 0) {
      unmatched.push(id);
      continue;
    }
    for (const match of matches) selected.add(match);
  }

  return { selected: [...selected], unmatched };
}

program
  .command('purge')
  .helpGroup('After the sweep:')
  .description('destroy the conversations behind deleted sessions — permanently, with no undo')
  .option('--title <text>', 'only conversations whose title contains this text')
  .option('--session <id...>', 'only these conversations, by id or unique prefix')
  .option('--config-dir <path...>', 'extra Claude config directories to search for conversations')
  .option('--this-store-only', 'judge "still referenced" from this installation alone')
  .option('--json', 'machine-readable list of what would be destroyed')
  .option('--yes', 'actually destroy; requires --confirm as well')
  .option('--confirm <count>', 'the number this run destroys, as printed by the dry run')
  .addOption(new Option('--dry-run', 'show what would happen and destroy nothing').conflicts('yes'))
  .action(function (this: Command) {
    const { store, ledger } = context(this);
    const opts = this.opts<{
      title?: string;
      session?: string[];
      configDir?: string[];
      thisStoreOnly?: boolean;
      json?: boolean;
      yes?: boolean;
      confirm?: string;
      dryRun?: boolean;
    }>();

    // Every installation gets a say in whether a conversation is still in use,
    // because a card in a profile homecoming is not pointed at right now is still a
    // card, and the session it opens is still there after a restart. Narrowing
    // that to one store is available, and is a worse question to ask. The store
    // in use is not in this list because findPurgeable always counts it.
    const referenceStores = opts.thisStoreOnly
      ? []
      : knownStores(ledger.read()).map((known) => layoutFor(known.root));

    let candidates = findPurgeable({
      store,
      referenceStores,
      env: process.env,
      configDirs: opts.configDir ?? [],
    });

    if (opts.title) {
      const needle = opts.title.toLowerCase();
      candidates = candidates.filter((item) =>
        (item.facts.title ?? '').toLowerCase().includes(needle),
      );
    }
    if (opts.session?.length) {
      const wanted = opts.session.map((id) => bareSessionId(id).toLowerCase());
      const matches = (item: (typeof candidates)[number], id: string) =>
        item.cliSessionId.toLowerCase().startsWith(id);
      // Refused rather than quietly narrowed, as every other identifier flag in
      // homecoming is. A typo that filtered to nothing fell through to "no deleted
      // session still has its conversation on disk", which reads as "you have
      // nothing left to clean up" and is not what happened.
      const unmatched = wanted.filter((id) => !candidates.some((item) => matches(item, id)));
      if (unmatched.length > 0) {
        throw new Error(
          `No purgeable conversation matches --session ${unmatched.join(', ')}.\n` +
            `Run "${programName()} purge" with no --yes to see what is available.`,
        );
      }
      candidates = candidates.filter((item) => wanted.some((id) => matches(item, id)));
    }

    const held = new Set(
      liveSessions(sessionRegistryRoots(process.env, opts.configDir ?? [])).map((session) =>
        session.sessionId.toLowerCase(),
      ),
    );
    // Settled before anything is printed, so the number the user is asked to
    // confirm is the number that will actually be destroyed — a conversation
    // held open by a live process is skipped, and confirming a total that
    // included it would be confirming something that never happens.
    const doomed = candidates.filter((item) => !held.has(item.cliSessionId.toLowerCase()));

    if (opts.json) {
      // The doomed set, not every candidate: this flag says it lists what would
      // be destroyed, and a script that feeds its length to --confirm has to get
      // the same answer the command reached. Held conversations go to stderr so
      // they are not lost, and stdout stays parseable.
      print(
        doomed.map((item) => ({
          cliSessionId: item.cliSessionId,
          title: item.facts.title ?? null,
          cwd: item.facts.cwd ?? null,
          lastActivityAt: item.facts.lastActivityAt ?? null,
          deletedAt: item.deletedAt ?? null,
          files: item.files,
          bytes: item.bytes,
        })),
      );
      const heldHere = candidates.length - doomed.length;
      if (heldHere > 0) {
        console.error(
          pc.dim(
            `${heldHere} more held open by a live claude process, and not listed: they cannot be purged now.`,
          ),
        );
      }
      return;
    }

    if (candidates.length === 0) {
      console.log('Nothing to purge: no deleted session still has its conversation on disk.');
      return;
    }

    const dryRun = opts.dryRun || !opts.yes;

    if (!dryRun) assertPurgeConfirmed(opts.confirm, doomed.length);

    const outcomes = purgeConversations(candidates, { ledger, dryRun, held });
    for (const outcome of outcomes) console.log(purgeLine(outcome, dryRun));

    const counts = summarisePurge(outcomes);
    if (dryRun) {
      console.log(
        pc.bold(
          `\nDry run: ${counts.purged} conversation(s) would be destroyed, ` +
            `${formatBytes(counts.bytes)} in total.`,
        ),
      );
      console.log(
        pc.red(
          `This cannot be undone, and ${programName()} keeps no copy. Read the list before confirming.`,
        ),
      );
      console.log(pc.dim(`Re-run with --yes --confirm ${counts.purged} to destroy them.`));
      return;
    }

    console.log(
      pc.bold(
        `\n${counts.purged} destroyed (${formatBytes(counts.bytes)}), ` +
          `${counts.skipped} skipped, ${counts.failed} failed.`,
      ),
    );
    // No restart offer, and nothing to see afterwards: these conversations had no
    // card in any sidebar — that is what made them purgeable — so the app's view
    // is exactly as it was.
    console.log(pc.dim("The app's deletion markers were left where they are."));
  });

program
  .command('grep')
  .helpGroup('Live sessions:')
  .summary('search every transcript this machine holds, by what was actually said')
  .description(
    "A regex over every client's transcripts — every conversation any account on\n" +
      'this machine ever ran, archived and deleted included, because a transcript\n' +
      "outlives the card that opened it. Each hit is matched against a message's\n" +
      'decoded text, never the raw JSONL, so it cannot fire on a `\\n` inside a JSON\n' +
      'escape or a uuid quoted inside a tool result. `--role` narrows to only what a\n' +
      'person typed or only what the assistant answered; with neither, both count and\n' +
      "the app's own bookkeeping records never do.\n\n" +
      'Every hit is grouped by conversation and shown with the card(s) — title,\n' +
      'account, archived — that open it; a conversation with no card left is shown\n' +
      'with none, which is what a deleted conversation nothing points at looks like.',
  )
  .argument('<regex>', 'a JavaScript-flavoured regex, case-sensitive; a plain phrase works too')
  .option('--account <accountUuid>', 'only conversations with a card in this account')
  .option('--since <age>', 'skip a transcript whose file is older than this, e.g. 7d, 24h')
  .option(
    '--cwd <fragment>',
    "case-insensitive substring of the conversation's own working directory",
  )
  .option('--role <role>', 'only "user" or only "assistant" records')
  .option('--limit <n>', 'stop once this many conversations have matched')
  .option('--json', 'machine-readable output')
  .action(function (this: Command, regexArg: string) {
    const { store } = context(this);
    const opts = this.opts<{
      account?: string;
      since?: string;
      cwd?: string;
      role?: string;
      limit?: string;
      json?: boolean;
    }>();

    if (opts.role !== undefined && opts.role !== 'user' && opts.role !== 'assistant') {
      throw new Error(`--role must be "user" or "assistant", not "${opts.role}".`);
    }

    let pattern: RegExp;
    try {
      pattern = new RegExp(regexArg);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`"${regexArg}" is not a valid regex: ${message}`);
    }

    let since: number | undefined;
    if (opts.since !== undefined) {
      since = parseSince(opts.since);
      if (since === undefined) {
        throw new Error(`Could not read --since "${opts.since}". Try 24h, 7d or 2w.`);
      }
    }

    let accountUuid: string | undefined;
    if (opts.account !== undefined) {
      accountUuid = matchAccountPrefix(listAccountDirs(store), opts.account, '--account')[0]!
        .accountUuid;
    }

    let limit: number | undefined;
    if (opts.limit !== undefined) {
      limit = Number(opts.limit);
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new Error(`--limit must be a positive integer, not "${opts.limit}".`);
      }
    }

    const startedAt = Date.now();
    const { conversations: results, unreadable } = grepTranscripts(store, pattern, {
      ...(accountUuid !== undefined ? { accountUuid } : {}),
      ...(since !== undefined ? { since } : {}),
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.role === 'user' || opts.role === 'assistant' ? { role: opts.role } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    const elapsedMs = Date.now() - startedAt;

    if (opts.json) {
      print({
        pattern: regexArg,
        elapsedMs,
        conversations: results.map((conversation) => ({
          cliSessionId: conversation.cliSessionId,
          cwd: conversation.cwd ?? null,
          hits: conversation.hits,
          cards: conversation.cards.map((card) => ({
            accountUuid: card.account.accountUuid,
            organizationUuid: card.account.organizationUuid,
            sessionId: card.sessionId,
            title: card.title ?? null,
            isArchived: card.isArchived,
          })),
        })),
        unreadable,
      });
      return;
    }

    if (unreadable.length > 0) {
      console.log(
        pc.yellow(
          `${unreadable.length} file(s) could not be read and were skipped: ${unreadable.slice(0, 3).join(', ')}${unreadable.length > 3 ? ', …' : ''}`,
        ),
      );
    }

    if (results.length === 0) {
      console.log(`No matches for ${regexArg}.`);
      console.log(pc.dim(`Searched in ${elapsedMs}ms.`));
      return;
    }

    for (const conversation of results) {
      const title = conversation.cards[0]?.title ?? pc.dim('(no card left — deleted or copy-only)');
      console.log(`${pc.bold(title)}  ${pc.dim(shortId(conversation.cliSessionId))}`);
      if (conversation.cwd) console.log(pc.dim(`  ${conversation.cwd}`));
      for (const card of conversation.cards) {
        console.log(
          pc.dim(
            `  card in ${card.account.accountUuid.slice(0, 8)}${card.isArchived ? ' (archived)' : ''}`,
          ),
        );
      }
      for (const hit of conversation.hits) {
        console.log(`    ${hit.role.padEnd(9)} ${formatDate(hit.at)}  ${hit.snippet}`);
      }
      console.log('');
    }
    console.log(pc.bold(`${results.length} conversation(s) matched.`));
    console.log(pc.dim(`Searched in ${elapsedMs}ms.`));
  });

program
  .command('export')
  .helpGroup('Live sessions:')
  .summary('render one conversation to Markdown, HTML or JSONL')
  .description(
    'Render one conversation, unioning every file it occupies (see the guide, "One\n' +
      'conversation can be two files") in timeline order and deduplicated by record\n' +
      'id. `md` shows user/assistant turns as headings with tool calls collapsed to\n' +
      'one line each; `html` is the same, self-contained; `jsonl` is every record\n' +
      'the conversation holds, deduplicated and ordered, exactly as a transcript\n' +
      'itself is written.\n\n' +
      'The conversation is resolved the way `--store` resolves a name: a conversation\n' +
      'id, exact or an unambiguous prefix — tried even against one with no card left,\n' +
      'since a deleted conversation naming its own id is the ordinary case here —\n' +
      "then a card's own id, then a case-insensitive fragment of a title. More than\n" +
      'one candidate at any step is refused rather than guessed at.',
  )
  .argument('<id>', 'a conversation id, a card id, or a fragment of its title')
  .option('--format <format>', 'md, html or jsonl', 'md')
  .option('--out <file>', 'write here instead of stdout')
  .action(function (this: Command, id: string) {
    const { store } = context(this);
    const opts = this.opts<{ format: string; out?: string }>();
    if (opts.format !== 'md' && opts.format !== 'html' && opts.format !== 'jsonl') {
      throw new Error(`--format must be md, html or jsonl, not "${opts.format}".`);
    }
    const format = opts.format as ExportFormat;

    const resolved = resolveConversation(id, store, listAccountDirs(store));
    if (resolved.files.length === 0) {
      throw new Error(
        `${resolved.cliSessionId} has no transcript on disk — only a conversation that ` +
          'ran on this machine can be exported.',
      );
    }

    const card = resolved.cards.find((session) => session.data.title !== undefined);
    const facts =
      card === undefined
        ? readTranscriptFacts(resolved.files[0]!, resolved.cliSessionId)
        : undefined;
    const records = readConversationRecords(resolved.files);
    const rendered = renderConversation(
      records,
      {
        cliSessionId: resolved.cliSessionId,
        ...(card?.data.title !== undefined
          ? { title: card.data.title }
          : facts?.title !== undefined
            ? { title: facts.title }
            : {}),
        ...(card?.data.cwd !== undefined
          ? { cwd: card.data.cwd }
          : facts?.cwd !== undefined
            ? { cwd: facts.cwd }
            : {}),
      },
      format,
    );

    if (opts.out) {
      writeFileSync(opts.out, rendered, 'utf8');
      console.error(pc.dim(`Wrote ${records.length} record(s) to ${opts.out}.`));
      return;
    }
    console.log(rendered);
  });

program
  .command('transcript')
  .helpGroup('Live sessions:')
  .summary("read a conversation's transcript")
  .description(
    "Read part of a conversation's transcript — the JSONL under the Claude config " +
      "directory's projects folder. The id is the cliSessionId that `list --json` " +
      'and `status --json` report. Reads the most recent part by default; --head ' +
      'reads the start instead.',
  )
  .argument('<cliSessionId>', 'the conversation id')
  .option('--head', 'read the start of the conversation instead of the most recent part')
  .option('--chars <n>', 'how much to read', '20000')
  .option('--json', 'facts and text as JSON')
  .action(function (this: Command, cliSessionId: string) {
    const opts = this.opts<{ head?: boolean; chars: string; json?: boolean }>();
    const chars = Number(opts.chars);
    if (!Number.isInteger(chars) || chars <= 0) {
      throw new Error(`--chars must be a positive integer, not "${opts.chars}".`);
    }

    const view = viewTranscript(
      bareSessionId(cliSessionId),
      process.env,
      opts.head ? 'head' : 'tail',
      chars,
    );

    if (opts.json) {
      print(view);
      return;
    }
    console.error(
      pc.dim(
        `${view.path}\n${view.title ?? '(untitled)'} — ${view.sizeBytes} bytes` +
          (view.truncated ? `, showing the ${view.part}` : ''),
      ),
    );
    // The text goes to stdout on its own so the command pipes cleanly.
    console.log(view.text);
  });

program
  .command('resume')
  .helpGroup('Live sessions:')
  .summary('send one prompt to an existing conversation, headlessly')
  .description(
    'Send one prompt to an existing conversation via `claude -p --resume` and ' +
      'print the answer.\n\n' +
      'This appends to the conversation, so it refuses when a live claude process ' +
      'is holding the conversation open — two writers on one transcript is how ' +
      `transcripts get corrupted. \`${programName()} live\` shows what is being held right ` +
      'now.',
  )
  .argument('<cliSessionId>', 'the conversation id')
  .argument('<prompt...>', 'what to say to it')
  .option('--timeout <seconds>', 'give up after this long', '300')
  .action(async function (this: Command, cliSessionId: string, prompt: string[]) {
    const opts = this.opts<{ timeout: string }>();
    const timeout = Number(opts.timeout);
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new Error(`--timeout must be a positive number of seconds, not "${opts.timeout}".`);
    }

    const result = await resumeConversation(cliSessionId, prompt.join(' '), {
      timeoutMs: timeout * 1000,
    });
    if ('refused' in result) {
      console.error(pc.yellow(result.refused));
      process.exitCode = 1;
      return;
    }
    console.log(result.output);
  });

program
  .command('live')
  .helpGroup('Live sessions:')
  .description('conversations a claude process is holding open right now')
  .option('--json', 'machine-readable output')
  .option('--stop <id...>', 'end the process holding these conversations, by id or unique prefix')
  .option('--prune', 'remove registry entries whose process is gone or has been replaced')
  .option('--yes', 'actually do it; without it nothing is stopped or removed')
  .action(async function (this: Command) {
    const opts = this.optsWithGlobals<
      GlobalOptions & { json?: boolean; stop?: string[]; prune?: boolean; yes?: boolean }
    >();
    const roots = sessionRegistryRoots(process.env);

    if (opts.prune) {
      pruneStale(roots, Boolean(opts.yes), Boolean(opts.json));
      return;
    }

    const sessions = liveSessions(roots);

    if (opts.stop?.length) {
      await reportStopped(sessions, opts.stop, Boolean(opts.yes), Boolean(opts.json));
      return;
    }

    // Which installation, if any, is actually hosting each entry. The registry
    // names no store — the card is the only place that link exists on disk —
    // so every installation homecoming knows about is checked for one.
    const events = (opts.ledger ? new Ledger(opts.ledger) : new Ledger()).read();
    const labels = project(events).labels;
    const storeCandidates: HostCandidate[] = knownStores(events, process.env).map((known) => ({
      root: known.root,
      name: known.name,
      accountUuid: known.accountUuid,
      exists: known.exists,
    }));
    // Built once for every entry `live` is about to report, rather than once per
    // entry — the card tree it reads does not get any smaller for asking one at
    // a time. See `buildHostedIndex`.
    const hostedIndex = buildHostedIndex(storeCandidates);

    if (opts.json) {
      print(
        sessions.map((s) => {
          const hosted = hostedStoreFor(s, hostedIndex);
          return {
            pid: s.pid,
            cliSessionId: s.sessionId,
            cwd: s.cwd ?? null,
            registryFile: s.registryFile,
            hostedBy: hosted
              ? {
                  root: hosted.root,
                  name: hosted.name ?? null,
                  lastSeenAs: hosted.accountUuid
                    ? (labels.get(hosted.accountUuid) ?? shortId(hosted.accountUuid))
                    : null,
                }
              : null,
          };
        }),
      );
      return;
    }

    if (sessions.length === 0) {
      console.log('No live claude sessions.');
      sayIfStale(roots);
      return;
    }
    for (const s of sessions) {
      const hosted = hostedStoreFor(s, hostedIndex);
      const detail = hosted ? hostedByLine(hosted, labels) : terminalSessionLine(s);
      console.log(`  ${String(s.pid).padStart(6)}  ${s.sessionId}  ${pc.dim(detail)}`);
    }
    console.log(
      pc.dim(`\nThese conversations have a writer; \`${programName()} resume\` will refuse them.`),
    );
    console.log(
      pc.dim(`\`${programName()} live --stop <id>\` ends one, so its copy can be opened.`),
    );
    sayIfStale(roots);
  });

program
  .command('detached')
  .helpGroup('Live sessions:')
  .summary('recent --detach runs — read this after the app comes back')
  .description(
    'What `--detach` launched most recently: whether it has fired yet, is mid-way ' +
      "through quitting/writing/restarting, or is done, plus the log's own tail.\n\n" +
      'This is what an agent reads to confirm a detached restart actually landed ' +
      '— the session that launched it ends with the app, so nothing in that ' +
      "session's own output can say so.",
  )
  .option('--last', "print the newest run's full log, not just its tail")
  .option('--json', 'machine-readable output')
  .action(function (this: Command) {
    const opts = this.opts<{ last?: boolean; json?: boolean }>();
    const runs = listDetachedRuns(process.env);

    if (opts.json) {
      print(
        runs.map((run) => ({
          id: run.id,
          status: run.status,
          vbs: run.vbsPath,
          log: run.logPath,
          ...(opts.last && run === runs[0] ? { fullLog: run.log ?? null } : {}),
        })),
      );
      return;
    }

    if (runs.length === 0) {
      console.log('No detached run has been launched from this machine.');
      return;
    }

    if (opts.last) {
      const [newest] = runs;
      if (!newest) return;
      console.log(pc.bold(`${newest.id}  ${statusWord(newest.status)}`));
      console.log(newest.log ?? pc.dim('(no log yet)'));
      return;
    }

    for (const run of runs) {
      console.log(pc.bold(`\n${run.id}  ${statusWord(run.status)}`));
      if (!run.log) {
        console.log(pc.dim('  (no log yet)'));
        continue;
      }
      for (const line of tailLines(run.log, 5)) console.log(`  ${line}`);
    }
  });

function statusWord(status: 'pending' | 'running' | 'done'): string {
  if (status === 'done') return pc.dim('done');
  if (status === 'running') return pc.yellow('running');
  return pc.dim('pending');
}

program
  .command('unstarted')
  .helpGroup('Live sessions:')
  .summary('background-task requests whose session died before answering once')
  .description(
    'Find requests in the account you are signed in to that never got a turn. A ' +
      'background-task chip is spawned into a ' +
      'session of its own; when that session dies before answering (a usage limit, an ' +
      'error at start-up) the card stays in the sidebar and the request inside it is ' +
      'gone. There is no conversation to resume, so this is not rescue: what survives ' +
      "is the prompt, in the transcript's first user record, and it is printed in full.\n\n" +
      'Nothing is re-run. A lost request can be weeks old and name work long since done ' +
      'another way, so the list is the product, and --since cuts the stale ones out of it.',
  )
  .option('--since <age>', 'how far back a lost request may have been created', '7d')
  .option('--archived', 'include cards you archived — closed on purpose, so opt-in')
  .option('--json', 'machine-readable output')
  .action(function (this: Command) {
    const { store, ledger } = context(this);
    const opts = this.opts<{ since: string; archived?: boolean; json?: boolean }>();
    const since = parseSince(opts.since);
    if (since === undefined) {
      throw new Error(`Could not read --since "${opts.since}". Try 48h, 3d or 2w.`);
    }

    // The account signed in, like `revive`: a request belongs to the account it
    // was spawned in, and this lists that account's own. A plugin can register
    // further sources (`unstartedSources`); the core registers none.
    const account = requireCurrentAccount(store, listAccountDirs(store));
    const own = scanAccount(store, account, copySessionIds(ledger.read()));
    const seen = new Set(own.map((session) => session.data.sessionId));
    const sessions = [
      ...own,
      ...extraUnstartedSessions(store).filter((session) => !seen.has(session.data.sessionId)),
    ];
    const index = indexTranscripts(transcriptRoots(process.env));
    const lost = findUnstarted(
      sessions,
      { since, includeArchived: opts.archived ?? false },
      { transcriptFor: (id) => index.get(id), promptIn: firstPrompt },
    );

    if (opts.json) {
      print(lost);
      return;
    }

    if (lost.length === 0) {
      console.log(`No request died before its first turn in the last ${opts.since}.`);
      if (!opts.archived) console.log(pc.dim('Cards you archived need --archived.'));
      return;
    }

    for (const row of lost) {
      const marks = [row.isArchived ? 'archived' : '', formatLifetime(row.lifetimeMs)]
        .filter(Boolean)
        .join(', ');
      console.log(
        `\n  ${formatAge(row.createdAt).padStart(8)}  ` +
          `${row.title ?? pc.dim('(untitled)')}${marks ? pc.dim(`  (${marks})`) : ''}`,
      );
      if (row.error) console.log(pc.yellow(`           ${row.error}`));
      if (row.cwd) console.log(pc.dim(`           ${row.cwd}`));
      if (row.prompt) {
        // Printed whole, indented. Truncating it would defeat the command: the
        // prompt is not a label for the row, it IS the row — the only part of a
        // request that died at zero turns that can be used again.
        console.log(pc.dim('           what was asked:'));
        for (const line of row.prompt.split('\n')) console.log(`             ${line}`);
      } else {
        console.log(
          pc.yellow('           transcript gone — the request itself is not recoverable'),
        );
      }
    }

    const recoverable = lost.filter((row) => row.prompt).length;
    console.log(
      pc.bold(
        `\n${lost.length} request(s) died before answering; ${recoverable} still have their prompt.`,
      ),
    );
    console.log(
      pc.dim(
        'Nothing here was re-run. Ask again where it belongs, after checking the work was\n' +
          'not already done another way — an old request usually has been.',
      ),
    );
  });

/** A lifetime worth naming: these die in seconds, and the number is the tell. */
function formatLifetime(ms: number | undefined): string {
  if (ms === undefined) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `lasted ${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `lasted ${minutes}m` : `lasted ${Math.round(minutes / 60)}h`;
}

/**
 * The wider window `rescue` offers when a narrow one found nothing.
 *
 * One literal, read both as the words in the sentence and — through
 * `parseSince`, the same parser the flag itself uses — as the moment to compare
 * against. Encoding it twice is what put a hint and a threshold out of step
 * once already.
 */
const SUGGESTED_RESCUE_WINDOW = '7d';

program
  .command('rescue')
  .helpGroup('Live sessions:')
  .summary('conversations stranded by a crash, and the resumes that bring them back')
  .description(
    'Find conversations whose sidebar card can only say "cannot reach your ' +
      'computer": they had a remote-control mirror, the process hosting them died ' +
      'without closing — a crash, a reboot — and no live claude process holds them ' +
      'now. The old mirror is server-side state and cannot be reattached from here; ' +
      'what works is resuming the conversation, which mints a fresh mirror on its ' +
      'first turn. Each row names the directory to resume in, read from the ' +
      "transcript itself — the card's own cwd goes stale when a session moves " +
      'between worktrees.\n\n' +
      '--open opens a Windows Terminal tab per conversation with `claude --resume` ' +
      "already running. Each tab stops at the CLI's own prompt, so nothing is " +
      'consumed until you pick summary or full there; `/desktop` inside a resumed ' +
      'session hands it back to the app. Empty mirror cards named after the device ' +
      '("no messages yet") hold nothing and cannot be rescued — archive them.',
  )
  .option('--since <age>', 'how far back a stranded conversation may have been active', '48h')
  .option(
    '--archived',
    'include sessions you archived — closed on purpose, so reviving one is opt-in',
  )
  .option('--open', 'open a Windows Terminal tab per conversation with the resume already running')
  .option('--json', 'machine-readable output')
  .action(function (this: Command) {
    const { store, ledger } = context(this);
    const opts = this.opts<{ since: string; archived?: boolean; open?: boolean; json?: boolean }>();
    const since = parseSince(opts.since);
    if (since === undefined) {
      throw new Error(`Could not read --since "${opts.since}". Try 48h, 3d or 2w.`);
    }

    const account = requireCurrentAccount(store, listAccountDirs(store));
    const sessions = scanAccount(store, account, copySessionIds(ledger.read()));
    const stranded = findStranded(
      sessions,
      { since, includeArchived: opts.archived ?? false },
      defaultRescueDeps(),
    );

    if (opts.json) {
      print(
        stranded.map((row) => ({
          cliSessionId: row.cliSessionId,
          title: row.title ?? null,
          cwd: row.cwd ?? null,
          cwdExists: row.cwdExists ?? null,
          transcriptPath: row.transcriptPath ?? null,
          sizeBytes: row.sizeBytes ?? null,
          lastActivityAt: row.lastActivityAt ?? null,
          isArchived: row.isArchived,
          resumeCommand: row.transcriptPath ? resumeCommandFor(row) : null,
        })),
      );
      return;
    }

    if (stranded.length === 0) {
      console.log(`Nothing looks stranded from the last ${opts.since}.`);
      // The window and the sentence offering it come from one literal, parsed
      // the way the flag itself is. Written twice — a string here and a
      // millisecond constant there — the next person to widen the suggestion
      // moves one and reintroduces the bug be44061 fixed.
      const now = Date.now();
      const wider = parseSince(SUGGESTED_RESCUE_WINDOW, now) ?? now;
      const windowIsShorterThanWeek = since > wider;
      if (windowIsShorterThanWeek && !opts.archived) {
        console.log(
          pc.dim(
            `A longer window is --since ${SUGGESTED_RESCUE_WINDOW}; sessions you archived need --archived.`,
          ),
        );
      } else if (windowIsShorterThanWeek) {
        console.log(pc.dim(`A longer window is --since ${SUGGESTED_RESCUE_WINDOW}.`));
      } else if (!opts.archived) {
        console.log(pc.dim('Sessions you archived need --archived.'));
      }
      return;
    }

    for (const row of stranded) {
      const marks = [row.isArchived ? 'archived' : '', formatSize(row.sizeBytes)]
        .filter(Boolean)
        .join(', ');
      console.log(
        `  ${formatAge(row.lastActivityAt).padStart(8)}  ` +
          `${row.title ?? pc.dim('(untitled)')}${marks ? pc.dim(`  (${marks})`) : ''}`,
      );
      if (!row.transcriptPath) {
        console.log(pc.yellow('           transcript missing — there is nothing left to resume'));
      } else if (!row.cwd) {
        console.log(
          `           ${resumeCommandFor(row)}  ` +
            pc.yellow('(directory unknown — run it where the work lived)'),
        );
      } else if (row.cwdExists === false) {
        console.log(pc.dim(`           ${row.cwd}`));
        console.log(
          pc.yellow(
            '           directory gone — a removed worktree. Recreate it (git worktree add),\n' +
              `           then: ${resumeCommandFor(row)}`,
          ),
        );
      } else {
        console.log(pc.dim(`           ${row.cwd}`));
        console.log(`           ${resumeCommandFor(row)}`);
      }
    }
    console.log(pc.bold(`\n${stranded.length} stranded conversation(s).`));

    if (!opts.open) {
      console.log(
        pc.dim(
          "Each resume stops at the CLI's own prompt, so nothing is consumed until you\n" +
            'choose summary or full there. --open opens a terminal tab per conversation.',
        ),
      );
      return;
    }

    if (process.platform !== 'win32') {
      console.log(
        pc.yellow('\n--open drives Windows Terminal; on this machine run the commands above.'),
      );
      return;
    }

    const outcomes = openResumeTabs(stranded);
    console.log('');
    for (const { row, outcome } of outcomes) {
      if (outcome === 'no-transcript') {
        console.log(pc.yellow(`  skipped ${shortId(row.cliSessionId)}: transcript missing`));
      } else if (outcome === 'no-cwd') {
        console.log(pc.yellow(`  skipped ${shortId(row.cliSessionId)}: no directory to resume in`));
      } else if (outcome === 'cwd-gone') {
        console.log(pc.yellow(`  skipped ${shortId(row.cliSessionId)}: its directory was removed`));
      } else if (outcome === 'failed') {
        console.log(pc.yellow(`  could not open a tab for ${shortId(row.cliSessionId)}`));
      }
    }
    const opened = outcomes.filter((entry) => entry.outcome === 'opened').length;
    console.log(`Opened ${opened} of ${stranded.length} in the "rescue" terminal window.`);
    console.log(
      pc.dim(
        'In each tab: choose how to resume — summary for work that ended in a handoff,\n' +
          'full for work cut mid-thought — then `/desktop` inside the session hands it\n' +
          'back to the app. The old unreachable card never reconnects; archive it.',
      ),
    );
  });

program
  .command('revive')
  .helpGroup('Live sessions:')
  .summary('sessions of this account a restart cut off or a usage limit stopped')
  .description(
    'List the sessions of the account signed in now whose own conversation ended\n' +
      "in the middle of a turn — a tool result, a background task's notification or\n" +
      'a prompt nothing answered, because the app was quit or restarted under it —\n' +
      'or on the app\'s own "You\'ve hit your limit" line. This is what to run after\n' +
      'a restart: each of these stopped mid-task, and is one message away from\n' +
      'carrying on. A limit on a session of this account is one to pick up here\n' +
      'once that limit resets. A fostered copy is left out: the stop in a shared\n' +
      'transcript belongs to the account the conversation ran in, not to this one.\n\n' +
      'Nothing here sends that message. Only Claude Desktop can deliver a turn to a\n' +
      'session and keep its card attached — `claude --resume` runs the turn and leaves\n' +
      'the row showing the stop — so the list is the work to hand back to each one, run\n' +
      'inside the app. One row per conversation and per git branch, the most recent\n' +
      'stop kept: two agents on one branch would commit over each other. Sessions a\n' +
      'live claude is writing, sessions whose folder is gone (the app refuses to\n' +
      'deliver to those), and fostered copies are left out and named.',
  )
  .option('--since <age>', 'how long ago the session may have stopped', '24h')
  .option('--archived', 'include sessions you archived — put away on purpose, so opt-in')
  .option('--json', 'machine-readable output')
  .action(function (this: Command) {
    const { store, ledger } = context(this);
    const opts = this.opts<{ since: string; archived?: boolean; json?: boolean }>();
    const since = parseSince(opts.since);
    if (since === undefined) {
      throw new Error(`Could not read --since "${opts.since}". Try 24h, 3d or 2w.`);
    }

    const account = requireCurrentAccount(store, listAccountDirs(store));
    const sessions = scanAccount(store, account, copySessionIds(ledger.read()));
    const { stopped, passedOver } = findStopped(
      sessions,
      { since, includeArchived: opts.archived ?? false },
      defaultReviveDeps(),
    );

    if (opts.json) {
      print({ account: account.accountUuid, stopped, passedOver });
      return;
    }

    if (stopped.length === 0) {
      console.log(
        `Nothing stopped on a usage limit or cut off mid-turn in the last ${opts.since}.`,
      );
    }
    for (const row of stopped) {
      console.log(
        `  ${formatAge(row.stoppedAt).padStart(8)}  ${row.title ?? pc.dim('(untitled)')}` +
          (row.branch ? pc.dim(`  (${row.branch})`) : ''),
      );
      const detail = row.why === 'cut-off' ? 'cut off mid-turn' : row.limit;
      if (detail) console.log(pc.dim(`           ${detail}`));
    }
    for (const row of passedOver) {
      const why =
        row.reason === 'live'
          ? 'a live claude is writing it'
          : row.reason === 'same-conversation'
            ? 'another row of the same conversation is on the list'
            : row.reason === 'same-branch'
              ? 'another conversation on the same branch is on the list'
              : row.reason === 'other-account'
                ? 'it is a copy from another account, and that stop belongs there'
                : `its folder is gone (${row.cwd ?? '?'}), and the app will not deliver there`;
      console.log(pc.dim(`  left out: ${row.title ?? '(untitled)'} — ${why}`));
    }
    if (stopped.length === 0) return;
    const limits = stopped.filter((row) => row.why === 'limit').length;
    console.log(
      pc.bold(
        `\n${stopped.length} session(s) to carry on: ${limits} stopped on a usage limit, ` +
          `${stopped.length - limits} cut off mid-turn.`,
      ),
    );
    console.log(
      pc.dim(
        'Tell each one inside Claude Desktop to carry on, highest return first.\n' +
          '--json is the same list, for a script.',
      ),
    );
  });

program
  .command('disk')
  .helpGroup('Reports:')
  .summary('where the bytes are: cards and transcripts, per account and per project')
  .description(
    'Read-only measurement of everything on disk, across every account this store ' +
      'has: card and transcript bytes broken down by account and by working ' +
      `directory, how much of a card's own JSON is fields nothing in ${programName()} ` +
      'reads (mostly remoteMcpServersConfig), transcripts no card in any account ' +
      'still points at, ' +
      'transcript files that are byte-for-byte copies of each other, and session ' +
      "cards already over the app's own 10 MB load limit and so will not appear in " +
      'it.\n\n' +
      'Nothing here deletes anything, and nothing here decides a file is safe to ' +
      `remove — that judgement is \`${programName()} purge\`'s, and it requires a tombstone ` +
      'this does not. Reading every card and every transcript on a large store ' +
      'takes a while; it stays read-only throughout, the same guarantee every other ' +
      'report in this tool gives.',
  )
  .option('--json', 'machine-readable output')
  .action(function (this: Command) {
    const { store, ledger } = context(this);
    const opts = this.opts<{ json?: boolean }>();
    const sessions = scanStore(store, copySessionIds(ledger.read()));
    const report = diskReport(store, sessions);

    if (opts.json) {
      print(report);
      return;
    }

    for (const line of diskReportLines(report, labelsOf(ledger))) console.log(line);
  });

/**
 * `stats --by`: its choices are the core's two dimensions plus whatever a
 * plugin registered, so they are set again by `runCli` once the plugins are in
 * (see `refreshStatsDimensions`), not frozen at load.
 */
const statsByOption = new Option('--by <dimension>', 'how to group the totals')
  .choices(statsDimensionNames())
  .default('model');

/** Brings `stats --by`'s accepted values in line with the dimensions registered now. */
function refreshStatsDimensions(): void {
  statsByOption.choices(statsDimensionNames());
}

program
  .command('stats')
  .helpGroup('Reports:')
  .summary('token usage and sessions, read from the transcripts')
  .description(
    "Read every transcript this machine holds for its assistant records' own " +
      '`usage` fields (input, output and cache tokens, and the model that generated ' +
      'them), aggregated per model or per week: a single total hides where the tokens ' +
      'actually went, and one model or one week can carry most of it. Nothing here ' +
      'goes to the network.',
  )
  .option('--since <age>', 'how far back to read', '30d')
  .addOption(statsByOption)
  .option('--json', 'machine-readable output')
  .action(function (this: Command) {
    context(this);
    const opts = this.opts<{ since: string; by: string; json?: boolean }>();
    const since = parseSince(opts.since);
    if (since === undefined) {
      throw new Error(`Could not read --since "${opts.since}". Try 30d, 12h or 4w.`);
    }

    const report = computeStats({ since, by: opts.by }, defaultStatsDeps());

    if (opts.json) {
      print(report);
      return;
    }

    for (const line of statsReportLines(report)) console.log(line);
  });

function accountLabel(uuid: string, labels: Map<string, string>): string {
  return labels.get(uuid) ?? shortId(uuid);
}

function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '0%';
}

function diskReportLines(report: DiskReport, labels: Map<string, string>): string[] {
  const lines: string[] = [];
  const { totals } = report;

  lines.push(
    `Cards:        ${formatBytes(totals.cardBytes)} across ${report.accounts.length} account(s), ` +
      `${totals.cardCount} file(s)`,
  );
  const heavy = report.bulkyFields
    .filter((field) => field.bytes > 0)
    .map((field) => `${field.field} ${formatBytes(field.bytes)}`);
  lines.push(
    pc.dim(
      `  bulky fields: ${formatBytes(totals.bulkyCardBytes)} ` +
        `(${percent(totals.bulkyCardBytes, totals.cardBytes)})` +
        (heavy.length > 0 ? ` — ${heavy.join(', ')}` : ''),
    ),
  );
  lines.push(
    `Transcripts:  ${formatBytes(totals.transcriptBytes)} across ${totals.transcriptCount} file(s)`,
  );

  if (report.accounts.length > 0) {
    lines.push('', pc.bold('By account:'));
    for (const usage of report.accounts) {
      lines.push(
        `  ${accountLabel(usage.account.accountUuid, labels).padEnd(24)} ` +
          `${formatBytes(usage.cardBytes)} cards (${percent(usage.bulkyCardBytes, usage.cardBytes)} bulky) · ` +
          `${usage.cardCount} card(s) · ${formatBytes(usage.transcriptBytes)} transcript(s) reached ` +
          `(${usage.transcriptCount} conversation(s))`,
      );
    }
  }

  const topProjects = report.projects.slice(0, 10);
  if (topProjects.length > 0) {
    lines.push('', pc.bold('By project (top 10 by combined bytes):'));
    for (const project of topProjects) {
      lines.push(
        `  ${project.project.padEnd(40)} ${formatBytes(project.cardBytes)} card(s) · ` +
          `${formatBytes(project.transcriptBytes)} transcript(s)`,
      );
    }
  }

  if (report.orphanTranscripts.length > 0) {
    const bytes = report.orphanTranscripts.reduce((sum, row) => sum + row.bytes, 0);
    lines.push(
      '',
      `${report.orphanTranscripts.length} transcript(s) (${formatBytes(bytes)}) have no card in any ` +
        `account — never tombstoned, so \`${programName()} purge\` will not offer them; remove by hand if sure.`,
    );
  }

  if (report.duplicateTranscripts.length > 0) {
    const reclaimable = report.duplicateTranscripts.reduce(
      (sum, group) => sum + group.bytes * (group.files.length - 1),
      0,
    );
    lines.push(
      '',
      `${report.duplicateTranscripts.length} group(s) of byte-identical transcripts ` +
        `(${formatBytes(reclaimable)} could be reclaimed by keeping one copy of each):`,
    );
    for (const group of report.duplicateTranscripts.slice(0, 10)) {
      lines.push(`  ${formatBytes(group.bytes)} × ${group.files.length}`);
      for (const file of group.files) lines.push(pc.dim(`    ${file}`));
    }
  }

  if (report.oversizedCards.length > 0) {
    lines.push(
      '',
      `${report.oversizedCards.length} session card(s) are already over the app's 10 MB load ` +
        'limit and will not appear in it:',
    );
    for (const card of report.oversizedCards) {
      lines.push(
        `  ${formatBytes(card.bytes)}  ${card.path}  ` +
          pc.dim(`(${accountLabel(card.account.accountUuid, labels)})`),
      );
    }
  }

  return lines;
}

/** Registered stats counters, appended to a report line; empty without any. */
function counterText(counters: Record<string, number> | undefined): string {
  if (!counters) return '';
  return Object.entries(counters)
    .map(([name, value]) => ` · ${name} ${value.toLocaleString()}`)
    .join('');
}

function statsReportLines(report: StatsReport): string[] {
  const lines: string[] = [];
  const days = Math.max(1, Math.round((Date.now() - report.since) / 86_400_000));
  lines.push(pc.bold(`Usage over the last ~${days} day(s), by ${statsDimensionLabel(report.by)}:`));

  if (report.buckets.length === 0) {
    lines.push(pc.dim('  nothing found in the transcripts this store can see.'));
    return lines;
  }

  for (const bucket of report.buckets) {
    const name = statsBucketName(report.by, bucket);
    const tokens =
      `in ${bucket.inputTokens.toLocaleString()} · out ${bucket.outputTokens.toLocaleString()} · ` +
      `cache-create ${bucket.cacheCreationTokens.toLocaleString()} · ` +
      `cache-read ${bucket.cacheReadTokens.toLocaleString()}`;
    lines.push(
      `  ${name.padEnd(28)} ${bucket.sessions} session(s)  ${tokens}${counterText(bucket.counters)}`,
    );
  }

  const t = report.totals;
  lines.push(
    '',
    pc.bold(
      `Total: ${t.sessions} session(s) · in ${t.inputTokens.toLocaleString()} · ` +
        `out ${t.outputTokens.toLocaleString()} · cache-create ${t.cacheCreationTokens.toLocaleString()} · ` +
        `cache-read ${t.cacheReadTokens.toLocaleString()}${counterText(t.counters)}`,
    ),
  );

  return lines;
}

program
  .command('where')
  .helpGroup('After the sweep:')
  .summary('every account and store holding a card for one conversation, and which to continue in')
  .description(
    'Replaces the three-measurement recipe run by hand when a conversation ' +
      '"didn\'t come in the sweep": which accounts show a card for it, how many ' +
      'files it occupies and which each card opens, and which row is actually worth ' +
      'opening.\n\n' +
      '`query` matches a session id or `cliSessionId` (bare, `local_`-prefixed, or ' +
      `any unique prefix), or a title fragment. Every installation \`${programName()}\` ` +
      'already knows about is searched (the installed app and any a store provider ' +
      'offers), not just the one `--store` would resolve to.\n\n' +
      'A fragment matching more than one conversation lists the candidates and ' +
      'exits 1 rather than guessing. Two ids that share a root — a fork, or the ' +
      'same id opened from two working directories — are one conversation here, ' +
      `ranked by the exact election \`${programName()} sweep\`'s own fileCards pass runs ` +
      '(not a re-implementation of it): the last answer, then records held that no ' +
      'sibling file holds, then the last message of any kind, then sheer size. When ' +
      'that election still ties — several rows open the very same file — the row in ' +
      'the account `--store` resolves to (the signed-in account) wins, visible ' +
      "before archived, ahead of every other account's row; only then the id. The " +
      'row that measure elects is marked as the one to continue in.',
  )
  .argument('<query>', 'a session id, a cliSessionId prefix, or a title fragment')
  .option('--json', 'machine-readable output')
  .action(function (this: Command, query: string) {
    const { store, ledger } = context(this);
    const opts = this.opts<{ json?: boolean }>();
    const events = ledger.read();
    const state = project(events);
    const copies = copySessionIds(events);
    // The account `--store` resolves to (the default when it is not given) is
    // the one the tiebreak below treats as "the signed-in account" — never
    // guessed from which row happens to sort first across every account the
    // search found. Undefined when the store has no cached identity yet, in
    // which case the tiebreak falls back to the id order it always used.
    const target = readConfig(store).lastKnownAccountUuid;

    const stores: { store: StoreLayout; name?: string }[] = [];
    const seenRoots = new Set<string>();
    for (const known of knownStores(events)) {
      if (!known.exists) continue;
      const layout = layoutFor(known.root);
      const key = comparablePath(layout.root);
      if (seenRoots.has(key)) continue;
      seenRoots.add(key);
      stores.push({ store: layout, ...(known.name ? { name: known.name } : {}) });
    }

    const entries: WhereEntry[] = [];
    for (const { store: storeLayout, name } of stores) {
      for (const account of listAccountDirs(storeLayout)) {
        for (const found of scanAccount(storeLayout, account, copies, { slim: true })) {
          entries.push({
            store: storeLayout,
            ...(name ? { storeName: name } : {}),
            account,
            session: found,
          });
        }
      }
    }

    const kin = lineage(process.env);
    const resolved = resolveWhereQuery(entries, query, kin);

    if (resolved.kind === 'none') {
      if (opts.json) {
        print({ query, matches: [] });
      } else {
        console.log(
          `No conversation matches "${query}" in any store ${programName()} knows about.`,
        );
      }
      process.exitCode = 1;
      return;
    }

    if (resolved.kind === 'ambiguous') {
      const titleOf = (ids: string[]): string[] => [
        ...new Set(
          entries
            .filter((entry) => ids.includes(entry.session.data.cliSessionId ?? ''))
            .map((entry) => entry.session.data.title ?? '(untitled)'),
        ),
      ];
      if (opts.json) {
        print({
          query,
          ambiguous: resolved.groups.map((group) => ({
            ...group,
            titles: titleOf(group.cliSessionIds),
          })),
        });
      } else {
        console.log(
          pc.bold(`"${query}" matches ${resolved.groups.length} different conversations:`) +
            '\n' +
            pc.dim('Run again with a longer id or a more specific title fragment.\n'),
        );
        for (const group of resolved.groups) {
          console.log(`  ${shortId(group.root)}  ${titleOf(group.cliSessionIds).join(' / ')}`);
        }
      }
      process.exitCode = 1;
      return;
    }

    const report = buildWhereReport(resolved.id, entries, kin, state, target);

    if (opts.json) {
      print(report);
      return;
    }

    printWhere(report);
  });

function printWhere(report: WhereReport): void {
  // `report.rows` is in card-discovery order, not sorted by the election
  // measure — the clean/canonical title is `working.title`, the row this
  // report elects to continue in (shown again below under "Continue in:").
  // Falling back to the first-discovered row only when nothing was elected.
  console.log(
    pc.bold(`${report.working?.title ?? report.rows[0]?.title ?? '(untitled)'}`) +
      pc.dim(`  (${shortId(report.cliSessionId)})`),
  );
  if (report.family.length > 1) {
    console.log(pc.dim(`  a fork: ${report.family.length} conversation(s) share this root`));
  }
  console.log(
    pc.dim(
      `  ${report.files.length} file(s), ${report.totalRecords} record(s) total across the family`,
    ),
  );
  console.log('');

  // `only` is `weighScans`' per-*file* measure: when two rows open the exact
  // same file — the ordinary case for two cards of one un-forked conversation
  // — every record in it is "only" held by that one file, which would print
  // as if each row alone accounted for the whole thing. Said instead as what
  // it is: a duplicate, not a second file, the same distinction
  // `fileCards.ts` draws before it ever marks a row.
  const fileCounts = new Map<string, number>();
  for (const row of report.rows) {
    if (row.file) fileCounts.set(row.file, (fileCounts.get(row.file) ?? 0) + 1);
  }

  for (const row of report.rows) {
    const mark = row.working ? pc.green('* ') : '  ';
    console.log(`${mark}${pc.bold(row.account.accountUuid)} ${pc.dim(row.store)}`);
    console.log(`    session ${row.sessionId}${row.isCopy ? pc.dim('  (fostered copy)') : ''}`);
    console.log(`    "${row.title}"${row.archived ? pc.dim('  [archived]') : ''}`);
    if (row.cwd) console.log(pc.dim(`    cwd: ${row.cwd}`));
    if (row.file) {
      const sameFileElsewhere = (fileCounts.get(row.file) ?? 0) > 1;
      const reach =
        row.reaches === undefined
          ? ''
          : `  reaches ${row.reaches} of ${report.totalRecords}` +
            (sameFileElsewhere
              ? '  (same file as another row below)'
              : row.only
                ? `, ${row.only} only here`
                : '');
      console.log(pc.dim(`    file: ${row.file}${reach}`));
    } else {
      console.log(
        pc.yellow('    file: could not be told (no cwd, or more than one file matches it)'),
      );
    }
    if (row.fosteredFrom) {
      console.log(
        pc.dim(
          `    a fostered copy of ${shortId(row.fosteredFrom.originSessionId)} ` +
            `in ${row.fosteredFrom.origin.accountUuid}, fostered ${formatDate(row.fosteredFrom.fosteredAt)}`,
        ),
      );
    }
    if (row.copiesMadeFromHere > 0) {
      console.log(pc.dim(`    ${row.copiesMadeFromHere} copy/copies made from this card`));
    }
    if (row.mark) {
      console.log(pc.dim(`    marked by ${programName()}: "${row.mark.from}" -> "${row.mark.to}"`));
    }
    console.log('');
  }

  if (report.working) {
    console.log(
      pc.bold(`Continue in: ${report.working.account.accountUuid} — "${report.working.title}"`),
    );
  } else {
    console.log(pc.yellow('No row could be measured — none of these cards has a readable file.'));
  }
}

program
  .command('verify')
  .helpGroup('After the sweep:')
  .summary(`after a restart, check nothing ${programName()} wrote was undone`)
  .description(
    `Read back every write the ledger says ${programName()} made to this account — card\n` +
      'titles and archived flags, pins, sidebar groups and routines — and say which\n' +
      `of them the app has since reverted. Meant to run after \`${programName()} layout --yes\n` +
      '--restart` (or `sweep --restart`) has quit and restarted the app: both write\n' +
      "in the gap while it is closed, and the app's own startup can save some of it\n" +
      'straight back over — measured twice on a real store, once for marks and once\n' +
      'for sidebar groups (see docs/guide).\n\n' +
      'Titles, archived flags and pins are checked exactly: the ledger alone proves\n' +
      `whether a card is back under a title it wore before ${programName()} touched it, or a\n` +
      'pin move never landed. Groups and routines cannot be checked as exactly — the\n' +
      'ledger keeps only counts of what a layout run applied, not which card went\n' +
      'into which group — so this only flags the shape actually measured once: an\n' +
      `account ${programName()} has applied groups or routines to before, now showing none,\n` +
      'while a fresh plan still wants to bring some. Anything short of that is\n' +
      'reported as pending, not asserted as undone. Read-only; writes nothing.',
  )
  .option('--json', 'machine-readable output')
  .action(function (this: Command) {
    const { store, ledger } = context(this);
    const opts = this.opts<{ json?: boolean }>();
    const account = requireCurrentAccount(store, listAccountDirs(store));
    const report = planVerify(store, account, ledger.read());

    if (opts.json) {
      print(report);
      if (report.undone) process.exitCode = 1;
      return;
    }

    printVerify(report);
    if (report.undone) process.exitCode = 1;
  });

function printVerify(report: VerifyReport): void {
  console.log(pc.bold(`Verifying ${report.target.accountUuid}`));

  if (report.marks.pending.length === 0) {
    console.log(pc.dim(`  titles/archived flags: every mark ${programName()} wrote still stands.`));
  } else {
    console.log(
      pc.red(`  titles/archived flags: ${report.marks.pending.length} reverted by the app:`),
    );
    for (const mark of report.marks.pending) {
      console.log(pc.dim(`      ${mark.path}  -> "${mark.title}"`));
    }
  }

  if (report.archiveMarks.pending.length === 0) {
    console.log(
      pc.dim(`  archived flags (archive sync): every write ${programName()} made still stands.`),
    );
  } else {
    console.log(
      pc.red(
        `  archived flags (archive sync): ${report.archiveMarks.pending.length} reverted by the app:`,
      ),
    );
    for (const item of report.archiveMarks.pending) {
      console.log(pc.dim(`      ${item.path}  -> ${item.to ? 'archived' : 'unarchived'}`));
    }
  }

  if (report.pins.unreadable) {
    console.log(pc.yellow(`  pins: could not be read — ${report.pins.unreadable}`));
  } else if (report.pins.pending.length === 0) {
    console.log(pc.dim('  pins: nothing pending.'));
  } else {
    console.log(
      pc.red(`  pins: ${report.pins.pending.length} not reflecting the row to continue in:`),
    );
    for (const move of report.pins.pending) {
      console.log(pc.dim(`      ${move.staleTitle} -> ${move.cleanTitle}`));
    }
  }

  if (report.groups.reset) {
    console.log(
      pc.red(
        `  groups: this account had groups applied before and now has none, ` +
          `while a fresh plan wants to bring ${report.groups.pendingNewGroups} group(s) ` +
          `and ${report.groups.pendingAssignments} assignment(s) — likely reverted by the app.`,
      ),
    );
  } else if (report.groups.pendingNewGroups + report.groups.pendingAssignments > 0) {
    console.log(
      pc.dim(
        `  groups: ${report.groups.nowGroups} group(s), ${report.groups.nowAssignments} assignment(s) now; ` +
          `a fresh \`${programName()} layout\` would still bring ${report.groups.pendingNewGroups} group(s) and ` +
          `${report.groups.pendingAssignments} assignment(s) — not necessarily undone, see \`${programName()} verify --help\`.`,
      ),
    );
  } else {
    console.log(pc.dim(`  groups: ${report.groups.nowGroups} group(s) now, nothing pending.`));
  }

  if (report.routines.reset) {
    console.log(
      pc.red(
        `  routines: this account had routines applied before and now has none, ` +
          `while a fresh plan wants to bring ${report.routines.pendingBring} — likely reverted by the app.`,
      ),
    );
  } else if (report.routines.pendingBring > 0) {
    console.log(
      pc.dim(
        `  routines: ${report.routines.nowCount} now; a fresh \`${programName()} layout\` would still bring ` +
          `${report.routines.pendingBring} — not necessarily undone.`,
      ),
    );
  } else {
    console.log(pc.dim(`  routines: ${report.routines.nowCount} now, nothing pending.`));
  }

  if (report.pinParity.undone.length === 0) {
    console.log(
      pc.dim(`  pins from other accounts: every pin ${programName()} added still stands.`),
    );
  } else {
    console.log(
      pc.red(`  pins from other accounts: ${report.pinParity.undone.length} no longer pinned.`),
    );
  }

  if (report.groupAssignments.undone.length === 0) {
    console.log(pc.dim(`  group filings: every row ${programName()} filed is still in its group.`));
  } else {
    console.log(
      pc.red(
        `  group filings: ${report.groupAssignments.undone.length} no longer where ${programName()} filed them:`,
      ),
    );
    for (const entry of report.groupAssignments.undone) {
      console.log(pc.dim(`      ${entry.cardId}  -> ${entry.groupName}`));
    }
  }

  if (report.viewCarried.undone.length === 0) {
    console.log(pc.dim(`  sidebar settings: every value ${programName()} carried still stands.`));
  } else {
    console.log(
      pc.red(
        `  sidebar settings: ${report.viewCarried.undone.length} changed since ${programName()} carried them:`,
      ),
    );
    for (const entry of report.viewCarried.undone) {
      console.log(
        pc.dim(
          `      ${entry.key}: expected ${JSON.stringify(entry.expected)}, now ${JSON.stringify(entry.actual)}`,
        ),
      );
    }
  }

  console.log('');
  console.log(
    report.undone
      ? pc.red(
          `Something ${programName()} wrote was undone. Run \`${programName()} layout --yes --restart\` to write it again.`,
        )
      : pc.bold(`Nothing ${programName()} wrote here has been undone.`),
  );
}

/** A size the rescue listing can afford: exact bytes read as noise there. */
function formatSize(bytes: number | undefined): string {
  return bytes === undefined ? '' : formatBytes(bytes);
}

/**
 * `hosted by <name|root>`, with `· last seen as <label>` appended when the
 * store carries the config's account hint. Without a hint nothing is guessed
 * at — the store is still named, the account just is not.
 */
function hostedByLine(hosted: HostCandidate, labels: Map<string, string>): string {
  const label = hosted.accountUuid
    ? (labels.get(hosted.accountUuid) ?? shortId(hosted.accountUuid))
    : undefined;
  return `hosted by ${hosted.name ?? hosted.root}` + (label ? ` · last seen as ${label}` : '');
}

/**
 * What to print for a session no installation claims — a plain terminal.
 *
 * "Client" means the config directory everywhere else this CLI says it
 * (`clients`, `src/store/clients.ts`), not the process's launch directory, so
 * that is what gets named here: two `dirname`s above the registry file, since
 * a session registers itself at `<configDir>/sessions/<pid>.json`. The launch
 * directory is still worth a line when it differs from the client root.
 */
function terminalSessionLine(session: LiveCliSession): string {
  const clientDir = path.dirname(path.dirname(session.registryFile));
  return session.cwd && session.cwd !== clientDir
    ? `${clientDir}  (cwd ${session.cwd})`
    : clientDir;
}

/**
 * Mention the files this list had to disregard.
 *
 * Said here because this is where someone is standing when the registry is what
 * they are thinking about, and because the alternative — a list that quietly
 * omits four entries somebody saw yesterday — is the shape of a bug report. The
 * scan is free: the process table it needs was read a moment ago and is still in
 * hand. Nothing is removed on the way past; `--prune` is a separate ask.
 */
function sayIfStale(roots: string[]): void {
  // Records only, though `--prune` sweeps more. The question this answers is
  // "where did the entry I saw yesterday go", and only a record was ever an
  // entry. The peer keys beside them are never swept by anyone, so a count that
  // included them would be non-zero on every machine with a history — a line
  // that is always there is one nobody reads, and it would be sitting under the
  // one list homecoming needs people to trust.
  const records = staleRegistryEntries(roots).filter((entry) => entry.sessionId !== undefined);
  if (records.length === 0) return;
  console.log(
    pc.dim(
      `\n${records.length} registry ${records.length === 1 ? 'entry names' : 'entries name'} a ` +
        `process that is gone or has been replaced.\n\`${programName()} live --prune\` clears them.`,
    ),
  );
}

/**
 * Drop registry entries that describe nothing.
 *
 * The registry is only tidied by the sessions that wrote it, so a crash — or a
 * reboot, which is every session at once — leaves files behind for as long as
 * nobody clears them. They are not inert: each one is a pid, and a pid Windows
 * has since handed to something else reads as a live writer until it is checked.
 * Removing them is offered rather than done, and only for entries whose process
 * is provably gone or provably somebody else.
 */
function pruneStale(roots: string[], apply: boolean, json: boolean): void {
  const stale = staleRegistryEntries(roots);
  const described = stale.map((item) => ({
    pid: item.pid,
    cliSessionId: item.sessionId ?? null,
    cwd: item.cwd ?? null,
    registryFile: item.file,
    why: item.why,
  }));
  // The records name conversations and are worth a line each; the peer keys
  // beside them are the same fact repeated in bulk, and printing seventy of them
  // would bury the few lines someone is actually reading.
  const records = described.filter((row) => row.cliSessionId !== null);
  const keyFiles = described.filter((row) => row.cliSessionId === null);
  const plural = (n: number) => (n === 1 ? 'key' : 'keys');

  if (!apply) {
    if (json) {
      print(described.map((row) => ({ ...row, removed: false })));
      return;
    }
    if (stale.length === 0) {
      console.log('Every registry entry still names its own process.');
      return;
    }
    for (const row of records) {
      console.log(`  ${String(row.pid).padStart(6)}  ${row.cliSessionId}  ${pc.dim(row.why)}`);
    }
    if (keyFiles.length > 0) {
      const n = keyFiles.length;
      console.log(
        pc.dim(`  ${n} peer ${plural(n)} from ${n === 1 ? 'a process' : 'processes'} that ended`),
      );
    }
    console.log(
      pc.dim(
        `\n${stale.length} stale ${stale.length === 1 ? 'file' : 'files'}. ` +
          'Re-run with --yes to remove them.',
      ),
    );
    return;
  }

  const { removed, failed } = pruneRegistry(stale);
  const gone = new Set(removed);

  if (json) {
    print(described.map((row) => ({ ...row, removed: gone.has(row.registryFile) })));
    return;
  }

  for (const row of records) {
    const mark = gone.has(row.registryFile) ? pc.dim('removed') : pc.yellow('could not remove');
    console.log(`  ${String(row.pid).padStart(6)}  ${row.cliSessionId}  ${mark}`);
  }
  const keysGone = keyFiles.filter((row) => gone.has(row.registryFile)).length;
  if (keysGone > 0) console.log(pc.dim(`  ${keysGone} peer ${plural(keysGone)}`));
  console.log(`\nRemoved ${removed.length} of ${stale.length}.`);
  if (failed.length > 0) {
    console.log(
      pc.yellow(
        `${failed.length} stayed: another client's directory, or a file that went on its own.`,
      ),
    );
  }
}

/**
 * Report what ending each named writer did, or why it was not attempted.
 *
 * The operation itself is `ops/writers`: which conversation a prefix names, what
 * must never be killed, and what could not be identified are decisions, and they
 * are made where they can be put to the test. What is left here is how the
 * answer reads — a refusal has to say enough that somebody can act on it without
 * running the command again.
 */
async function reportStopped(
  sessions: LiveCliSession[],
  wanted: string[],
  apply: boolean,
  json: boolean,
): Promise<void> {
  const results = await stopWriters(selectWriters(sessions, wanted), { apply });

  if (json) {
    print(
      results.map(({ session, outcome }) => ({
        pid: session.pid,
        cliSessionId: session.sessionId,
        cwd: session.cwd ?? null,
        outcome,
      })),
    );
    return;
  }

  for (const { session, outcome, reason } of results) {
    const where = session.cwd ? ` in ${session.cwd}` : '';
    const head = `  ! ${session.pid}  ${session.sessionId}${where}`;

    if (outcome === 'refused-self') {
      console.log(
        pc.yellow(
          `${head}\n` +
            `    This is the session ${programName()} is running in. Ending it would kill this command\n` +
            `    part-way through. Close it yourself, or run ${programName()} from another terminal.`,
        ),
      );
    } else if (outcome === 'refused-unidentified') {
      console.log(pc.yellow(`${head}\n${indented(reason ?? '')}`));
    } else if (outcome === 'would-end') {
      console.log(`  × ${session.pid}  ${session.sessionId}${pc.dim(where)}`);
    } else if (outcome === 'ended') {
      console.log(`  ✕ ${session.pid}  ${session.sessionId}${pc.dim(where)}`);
    } else {
      console.log(pc.yellow(`  ! ${session.pid} did not end.`));
    }
  }

  if (!apply) {
    console.log(
      pc.red(
        '\nDry run. Ending a session is a kill: anything it had not written yet is lost,' +
          '\nand what is already in the transcript stays.',
      ),
    );
    console.log(pc.dim('Re-run with --yes to end them.'));
  }
}

function indented(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

const app = program
  .command('app')
  .helpGroup('The app:')
  .description('inspect or restart Claude Desktop')
  .action(function (this: Command) {
    reportDesktop(this);
  });

app
  .command('status')
  .description('whether the app is running, and what it is hosting')
  .option('--json', 'machine-readable output')
  .action(function (this: Command) {
    reportDesktop(this);
  });

function reportDesktop(command: Command): void {
  const { store, ledger } = context(command);
  // The instance running this store, so `--store <profile> app status` describes
  // that profile rather than whichever app was found first.
  const state = inspectDesktopFor(storeIdentity(store.root));

  // The registry entries the card cross-reference says belong to this store —
  // see `hostedStoreFor` — checked against this one installation rather than
  // every known one, since that is the question `app status` is asked.
  const accountUuid = readConfig(store).lastKnownAccountUuid;
  const candidate: HostCandidate = { root: store.root, accountUuid, exists: true };
  const hostedIndex = buildHostedIndex([candidate]);
  const hosted = liveSessions(sessionRegistryRoots(process.env)).filter(
    (session) => hostedStoreFor(session, hostedIndex) !== undefined,
  );

  // Computed unconditionally so `--json` carries the same label `live --json`
  // does for the same concept (`hostedBy.lastSeenAs`) — a JSON consumer should
  // not see less than the text branch prints below.
  const labels = labelsOf(ledger);
  const lastSeenAs = accountUuid ? (labels.get(accountUuid) ?? shortId(accountUuid)) : null;

  if (command.opts<{ json?: boolean }>().json) {
    print({
      ...state,
      appId: packagedAppId(store) ?? null,
      hostedSessions: hosted.map((s) => ({ pid: s.pid, cliSessionId: s.sessionId, lastSeenAs })),
    });
    return;
  }

  if (!state.running) {
    // uncertain rides along on the object spread in the --json branch above, so
    // this text branch is the only place that has to say it out loud.
    if (state.uncertain) {
      console.log(pc.yellow(`Cannot tell whether Claude Desktop is running: ${state.uncertain}`));
    } else {
      console.log('Claude Desktop is not running.');
    }
    return;
  }
  console.log(`Claude Desktop is running (pid ${state.mainPid}).`);
  if (state.startedAt) console.log(pc.dim(`  started ${formatAge(state.startedAt)}`));
  if (state.codeSessions > 0)
    console.log(pc.dim(`  hosting ${state.codeSessions} Claude Code session(s)`));
  if (hosted.length > 0) {
    console.log(pc.dim(`  hosted sessions${lastSeenAs ? ` · last seen as ${lastSeenAs}` : ''}:`));
    for (const s of hosted) console.log(pc.dim(`    ${s.sessionId}  (pid ${s.pid})`));
  }
  if (state.selfHosted)
    console.log(pc.yellow(`  ${programName()} is running inside it, so it cannot close it`));
}

app
  .command('quit')
  .description('ask Claude Desktop to close')
  .option('--terminate', 'end the process — required while the app keeps a tray icon')
  .action(async function (this: Command) {
    const { store } = context(this);
    await closeDesktop(store, Boolean(this.opts<{ terminate?: boolean }>().terminate));
  });

app
  .command('start')
  .description('start Claude Desktop')
  .action(async function (this: Command) {
    const { store } = context(this);
    let launchedWith: 'identity' | 'direct' | undefined;
    const started = await startDesktop(store, {
      onProfileLaunch: (method) => {
        launchedWith = method;
      },
      onWindowRaised: () =>
        console.log(pc.dim('the window came up hidden; sent another launch to raise it')),
    });
    if (launchedWith === 'identity') console.log(pc.dim('started with package identity'));
    else if (launchedWith === 'direct') {
      console.log(
        pc.yellow(
          'started without package identity: the browser callback will not reach it; use the e-mail code',
        ),
      );
    }
    console.log(started ? 'Claude Desktop is up.' : 'Started it; it has not taken the store yet.');
  });

registerAppPref(app, (command) => ({ store: context(command).store }));

addDetachOptions(
  app
    .command('restart')
    .description('close Claude Desktop and start it again, rebuilding the sidebar')
    .option('--terminate', 'end the process — required while the app keeps a tray icon'),
).action(async function (this: Command) {
  const { store } = context(this);
  const opts = this.opts<{
    terminate?: boolean;
    detach?: boolean;
    detachDelay?: string;
    detachEvenWithLive?: boolean;
  }>();
  if (opts.detach) {
    const detachDelay = parseDetachDelay(opts.detachDelay);
    if (typeof detachDelay !== 'number') throw new Error(detachDelay.error);
    const outcome = await runDetach(
      store,
      process.argv.slice(2),
      detachDelay,
      Boolean(opts.detachEvenWithLive),
    );
    printDetachResult(outcome, false, detachNotNeededNote(store));
    return;
  }
  await restartDesktop(store, Boolean(opts.terminate));
});

/**
 * The way out of a refusal, in the words of the command the user actually typed.
 *
 * "Re-run with --terminate" is only true where that flag exists. Reached from a
 * write that was asked to restart the app, it named an option `homecoming foster`
 * has never had, so following the advice answered "unknown option '--terminate'".
 */
const RERUN_WITH_TERMINATE = 'Re-run with --terminate';

async function closeDesktop(
  store: StoreLayout,
  terminate: boolean,
  retry: string = RERUN_WITH_TERMINATE,
): Promise<boolean> {
  const result = await quitDesktop(store, { terminate });
  if (result.outcome === 'not-running') {
    console.log('Claude Desktop was not running.');
    return true;
  }
  if (result.outcome === 'quit') {
    console.log('Claude Desktop is closed.');
    return true;
  }
  if (result.outcome === 'needs-terminate' || result.outcome === 'hides-to-tray') {
    // Not an escalation this can make on its own: with the tray on there is no
    // way to ask, and ending the process skips the app's own shutdown.
    //
    // The same note either way. `needs-terminate` is the prediction, made before
    // anything was tried; `hides-to-tray` is the observation, made because the
    // prediction was wrong and the window went away for nothing. What the
    // user has to do next is identical, so saying it differently would only
    // dress up an internal distinction as news.
    console.log(pc.yellow(trayNote(retry)));
    process.exitCode = 1;
    return false;
  }
  // Reached after the app was actually asked to go. "Quit it from the tray icon"
  // is the right ending, but on its own it reads as advice the user has already
  // taken — they typed --terminate precisely because the tray note told them to.
  // What was missing is why it did not work, which only the kill can say.
  console.log(
    pc.yellow(
      terminate
        ? `Claude Desktop (pid ${result.mainPid}) is still running: ending it did not take effect.`
        : 'Claude Desktop is still running.',
    ),
  );
  if (result.refused) console.log(pc.dim(`  ${result.refused}`));
  console.log(pc.dim('Quit it from the tray icon, then re-run.'));
  process.exitCode = 1;
  return false;
}

async function restartDesktop(
  store: StoreLayout,
  terminate: boolean,
  retry?: string,
): Promise<void> {
  if (inspectApp(store).running && !(await closeDesktop(store, terminate, retry))) return;
  const started = await startDesktop(store);
  console.log(
    started
      ? 'Claude Desktop is up, with the sidebar rebuilt.'
      : 'Started it; it has not taken the store yet.',
  );
}

/**
 * Runs the CLI: registers each plugin (its extensions, then its commands), fits
 * the registered command extenders onto the core commands, then parses `argv`. Errors print in red and set exit code 1 rather than throwing,
 * the way every command has always failed, and that includes a plugin whose
 * `usePlugin` or `register` throws: every plugin registered so far is taken
 * back out and `argv` is not run. Resolves to a function that
 * unregisters the plugins' extensions again (commands, once added to the
 * program, stay).
 */
export async function runCli(
  options: { plugins?: readonly HomecomingPlugin[]; argv?: readonly string[] } = {},
): Promise<() => void> {
  const pluginContext: PluginContext = { context, print, commandPath };
  const undo: (() => void)[] = [];
  const unregister = () => {
    for (const step of undo.reverse()) step();
    undo.length = 0;
  };
  // A plugin that fails to register is an error like any other: printed, exit
  // code 1, nothing thrown, and nothing half-registered left behind. The
  // command line is not run with a plugin missing.
  for (const plugin of options.plugins ?? []) {
    try {
      undo.push(usePlugin(plugin));
      plugin.register?.(program, pluginContext);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        pc.red(
          message.startsWith(`plugin "${plugin.name}"`)
            ? message
            : `plugin "${plugin.name}" could not be registered: ${message}`,
        ),
      );
      process.exitCode = 1;
      unregister();
      return unregister;
    }
  }
  // Once every plugin is in: the options and hooks command extenders (and
  // next-step hints) add to core commands, and the dimensions `stats --by`
  // accepts. An extender naming a command that does not exist fails the run
  // the same way a plugin that cannot register does.
  try {
    undo.push(applyCommandExtenders(program, context, print));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(pc.red(message));
    process.exitCode = 1;
    unregister();
    return unregister;
  }
  refreshStatsDimensions();
  try {
    if (options.argv) await program.parseAsync([...options.argv], { from: 'user' });
    else await program.parseAsync();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(pc.red(message));
    if (error instanceof DesktopControlError) console.error(pc.dim('Nothing was changed.'));
    process.exitCode = 1;
  }
  return unregister;
}
