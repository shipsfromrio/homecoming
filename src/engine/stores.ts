import { existsSync } from 'node:fs';
import {
  candidateStoreRoots,
  directoryKey,
  isLegacyAppDataStore,
  layoutFor,
  resolveStore,
  storeIdentity,
} from '../domain/paths.js';
import type { StoreLayout } from '../domain/types.js';
import { uniquePrefix } from '../domain/prefix.js';
import type { LedgerEvent } from '../ledger/types.js';
import { project, type LedgerState } from '../ledger/project.js';
import {
  desktopExecutable,
  inspectDesktopFor,
  readProcesses,
  type ProcessLister,
} from './desktop.js';
import { lockfileHeld } from './lockfile.js';
import { credentialReported, readConfig } from '../store/config.js';

/**
 * Every installation that can be named without being told: the installed app
 * in its conventional location, plus whatever a registered store provider
 * offers. Anything else is reached by passing its path to `--store`.
 *
 * Directories that have since gone are dropped rather than offered: a menu
 * entry that fails when picked is worse than one that was never there. A
 * provided entry may be the exception, see `KnownStore.exists`.
 */
export interface KnownStore {
  root: string;
  /** A short name to reach it by with `--store`, when a provider gave one. */
  name?: string;
  /** How it came to be known: the conventional location, or a provider. */
  hint: 'installed app' | 'provided';
  running: boolean;
  /**
   * Whether the directory is still there. The installed app requires this to
   * be true to be offered at all. A provided entry with a name is kept, marked
   * gone, so `--store <name>` can say which one went missing.
   */
  exists: boolean;
  /**
   * The account this installation last recorded, when it has one. A store with
   * none has not been signed into yet, which is why fostering into it refuses.
   */
  accountUuid?: string;
  /**
   * Whether a registered credential probe reported a cached sign-in token.
   * The core never looks, so this stays unset unless a plugin says so, and it
   * is only ever `true`. A probe reports presence and nothing else. Neither
   * this nor `accountUuid` proves who is signed in now.
   */
  hasTokenCache?: boolean;
  /**
   * Set when this row is the pre-MSIX `%APPDATA%\Claude` store, sitting
   * alongside a `Packages\Claude_<hash>` installation `directoryKey` did not
   * fold it into — see `isLegacyAppDataStore`. Only ever true outside the
   * app's own container, which is exactly where the two would otherwise read
   * as two unrelated installations rather than one store seen two ways.
   */
  legacy?: boolean;
  /**
   * A line of explanation the provider that offered this installation attached
   * (its `hint`), for anything that lists stores to print beside the root. The
   * core writes none. Named `note` because `hint` above already says where the
   * entry came from.
   */
  note?: string;
  /**
   * What to do when this installation is gone, as the provider that offered it
   * worded it. Appended to the error `--store <name>` raises for a gone entry;
   * the core writes none.
   */
  remedy?: string;
}

/** One installation a {@link StoreProvider} offers. */
export interface ProvidedStore {
  root: string;
  name?: string;
  /** A line of explanation, surfaced as `KnownStore.note`. */
  hint?: string;
  /** What to do when the directory is gone, surfaced as `KnownStore.remedy`. */
  remedy?: string;
}

/**
 * A source of installations beyond the conventional location. Registered with
 * {@link registerStoreProvider}; consulted by {@link knownStores}.
 */
export type StoreProvider = (context: {
  events: LedgerEvent[];
  env: NodeJS.ProcessEnv;
}) => ProvidedStore[];

const storeProviders: StoreProvider[] = [];

/** Adds a source of installations. Returns a function that removes it again. */
export function registerStoreProvider(provider: StoreProvider): () => void {
  storeProviders.push(provider);
  return () => {
    const at = storeProviders.indexOf(provider);
    if (at >= 0) storeProviders.splice(at, 1);
  };
}

/** Just the read: this takes the ledger's events, not the object holding them. */
export function knownStores(
  events: LedgerEvent[],
  env: NodeJS.ProcessEnv = process.env,
): KnownStore[] {
  const seen = new Map<string, KnownStore>();
  const stores: KnownStore[] = [];

  const offer = (
    root: string,
    hint: KnownStore['hint'],
    name?: string,
    legacy?: boolean,
    extra: Pick<KnownStore, 'note' | 'remedy'> = {},
  ): void => {
    const store = layoutFor(root);
    // The filesystem decides what is the same store and what still exists.
    const key = directoryKey(store.root);

    if (key === undefined) {
      if (hint === 'provided' && name !== undefined) {
        stores.push({ root: store.root, name, hint, running: false, exists: false, ...extra });
      }
      return;
    }

    const known = seen.get(key);
    if (known) {
      if (name !== undefined) known.name ??= name;
      if (legacy) known.legacy = true;
      if (extra.note !== undefined) known.note ??= extra.note;
      if (extra.remedy !== undefined) known.remedy ??= extra.remedy;
      return;
    }

    const config = readConfig(store);
    const found: KnownStore = {
      root: store.root,
      hint,
      running: lockfileHeld(store),
      exists: true,
      ...(name !== undefined ? { name } : {}),
      ...(config.lastKnownAccountUuid ? { accountUuid: config.lastKnownAccountUuid } : {}),
      ...(credentialReported(store) ? { hasTokenCache: true } : {}),
      ...(legacy ? { legacy: true } : {}),
      ...extra,
    };
    seen.set(key, found);
    stores.push(found);
  };

  for (const dir of candidateStoreRoots(env)) {
    // Only ever true for a plain %APPDATA%\Claude sitting beside a packaged
    // install it did not fold into (isLegacyAppDataStore gates on the packaged
    // root actually being present).
    offer(dir, 'installed app', undefined, isLegacyAppDataStore(dir, env));
  }
  for (const provider of storeProviders) {
    for (const entry of provider({ events, env })) {
      offer(entry.root, 'provided', entry.name, undefined, {
        ...(entry.hint !== undefined ? { note: entry.hint } : {}),
        ...(entry.remedy !== undefined ? { remedy: entry.remedy } : {}),
      });
    }
  }

  return stores;
}

/** What `storeExecutable` reports about one installation. */
export interface StoreExecutableInfo {
  executable?: string;
  /** Parsed out of the MSIX package folder name in `executable` — see below. */
  version?: string;
}

/** `Claude_0.13.15.0_x64__8wekyb3d8bbwe` — the version sits between two underscores. */
const PACKAGE_VERSION = /claude_([\d.]+)_/i;

/**
 * The executable that would run one particular store, and the version folded
 * into its own path.
 *
 * A running instance is proof: `inspectDesktopFor` already works out which
 * process is *this* store's own — two profiles up means two mains, and only the
 * ancestry walk tells them apart — so its live path beats anything guessed.
 * `updaterLastSeenVersion` in config.json is not used here on purpose: it is
 * the release the updater last *saw*, which after a staged update runs ahead of
 * the build actually on disk (see `store/config.ts`), while a running process's
 * own path names the file that is actually executing.
 *
 * A stopped store has no live process to ask, but every profile launches
 * through the one binary Windows knows how to start on this machine — the
 * `claude://` handler names it — so the registered command is the best
 * available answer, not a guess specific to this store.
 */
export function storeExecutable(
  root: string,
  list: ProcessLister = readProcesses,
  env: NodeJS.ProcessEnv = process.env,
  read?: () => string | undefined,
): StoreExecutableInfo {
  const state = inspectDesktopFor(storeIdentity(root, env), list, env);
  const runningPath =
    state.running && state.mainPid !== undefined
      ? list().find((row) => row.pid === state.mainPid)?.path
      : undefined;
  const executable = runningPath || desktopExecutable(read, list, env);
  if (!executable) return {};
  const version = PACKAGE_VERSION.exec(executable)?.[1];
  return { executable, ...(version ? { version } : {}) };
}

/**
 * The account half of `resolveStoreArg`: a label or a uuid prefix,
 * matched against the accounts `knownStores` actually holds — not every account
 * the ledger has ever heard of, which would happily resolve a name to a store
 * that was retired years ago. `undefined` means none of the three named this
 * account at all, which is not the same as naming it ambiguously; the caller
 * moves on to the substring pass for the first and throws for the second.
 */
function resolveByAccount(
  arg: string,
  stores: KnownStore[],
  state: LedgerState,
): StoreLayout | undefined {
  const uuids = [
    ...new Set(
      stores.map((store) => store.accountUuid).filter((u): u is string => u !== undefined),
    ),
  ];
  const wanted = arg.toLowerCase();

  const byLabel = uuids.filter((uuid) => state.labels.get(uuid)?.toLowerCase() === wanted);

  let matched: string[];
  if (byLabel.length) matched = byLabel;
  else {
    const prefix = uniquePrefix(uuids, arg, (uuid) => uuid);
    if (prefix.kind === 'none') return undefined;
    matched = prefix.kind === 'one' ? [prefix.id] : prefix.ids;
  }

  // A label names an account, not an installation, and the same
  // account can sit in more than one store — the case `--store` cannot guess
  // through, same as an ambiguous path piece below.
  const matchingStores = stores.filter(
    (store) => store.accountUuid !== undefined && matched.includes(store.accountUuid),
  );
  if (matchingStores.length === 1) return layoutFor(matchingStores[0]!.root);

  const lines = matchingStores.map((store) => `  ${store.root}`).join('\n');
  throw new Error(
    `--store "${arg}" names an account last seen by ${matchingStores.length} installations:\n${lines}`,
  );
}

/**
 * One more meaning for `--store`: given the argument and what is already known,
 * the store it names, or `undefined` for "not mine". Registered with
 * {@link registerStoreArgResolver}; consulted by {@link resolveStoreArg} after
 * a path that exists, a provided store's name and an account, and before the
 * path-piece pass. It can only add meanings: every earlier one still wins.
 */
export type StoreArgResolver = (
  arg: string,
  context: { events: LedgerEvent[]; env: NodeJS.ProcessEnv; stores: readonly KnownStore[] },
) => StoreLayout | undefined;

const storeArgResolvers: StoreArgResolver[] = [];

/** Adds a meaning for `--store`. Returns a function that removes it again. */
export function registerStoreArgResolver(resolver: StoreArgResolver): () => void {
  storeArgResolvers.push(resolver);
  return () => {
    const at = storeArgResolvers.indexOf(resolver);
    if (at >= 0) storeArgResolvers.splice(at, 1);
  };
}

/**
 * What `--store` names: a directory, a provided store's name, an account (label
 * or uuid prefix), or a distinctive piece of a known path.
 *
 * In that order. A path that exists is always taken as a path, so this can only
 * add meanings, never change one. An abbreviation matching two installations is
 * reported rather than guessed at: with `--store` the guess decides which
 * installation gets written to.
 */
export function resolveStoreArg(
  arg: string | undefined,
  // A thunk, not the events: the two answers that need no ledger at all are the
  // two every ordinary run takes, and reading it for them would be work done to
  // be thrown away.
  readEvents: () => LedgerEvent[],
  env: NodeJS.ProcessEnv = process.env,
): StoreLayout {
  if (arg === undefined) return resolveStore(undefined, env);
  if (existsSync(arg)) return layoutFor(arg);

  const events = readEvents();
  const stores = knownStores(events, env);
  const wanted = arg.toLowerCase();

  const named = stores.find((store) => store.name?.toLowerCase() === wanted);
  if (named) {
    if (!named.exists) {
      throw new Error(
        `store "${named.name}" is known at ${named.root}, which is gone.` +
          (named.remedy ? `\n${named.remedy}` : ''),
      );
    }
    return layoutFor(named.root);
  }

  const byAccount = resolveByAccount(arg, stores, project(events));
  if (byAccount) return byAccount;

  // Registered resolvers get their turn after every meaning the core owns
  // except the loosest one. A resolver that throws is set aside rather than
  // allowed to replace the answer: the path-piece pass may still find the
  // store, and if nothing does, its failure is reported alongside the
  // "not a directory" error instead of in place of it.
  const resolverFailures: string[] = [];
  for (const resolver of [...storeArgResolvers]) {
    try {
      const found = resolver(arg, { events, env, stores });
      if (found) return found;
    } catch (error) {
      resolverFailures.push(error instanceof Error ? error.message : String(error));
    }
  }

  // A name already had its chance above; a gone entry matching here by path
  // piece would resolve to a directory that is not there, so it is excluded.
  const matches = stores.filter(
    (store) => store.exists && store.root.toLowerCase().includes(wanted),
  );

  if (matches.length === 1) return layoutFor(matches[0]!.root);
  if (matches.length > 1) {
    const lines = matches.map((store) => `  ${store.root}`).join('\n');
    throw new Error(`--store "${arg}" matches ${matches.length} installations:\n${lines}`);
  }

  // Nothing on disk and nothing known, by name, by account, or by path piece:
  // a typo, most likely, and continuing would quietly report an empty store
  // rather than say so.
  const known = stores
    .map(
      (store) =>
        `  ${store.name ? `${store.name} — ` : ''}${store.root}${store.exists ? '' : ' (gone)'}`,
    )
    .join('\n');
  throw new Error(
    `--store "${arg}" is not a directory, a known store name, a known account, or a piece ` +
      `of a known path.` +
      (known ? `\nKnown installations:\n${known}` : '') +
      resolverFailures.map((message) => `\nA store resolver failed: ${message}`).join(''),
  );
}
