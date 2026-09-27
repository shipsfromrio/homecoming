import pc from 'picocolors';
import { listAccountDirs, listAgentAccountDirs } from '../domain/paths.js';
import type { AccountRef, StoreLayout } from '../domain/types.js';
import type { Ledger } from '../ledger/log.js';
import { project } from '../ledger/project.js';
import { readConfig } from '../store/config.js';
import { readIdentityFromCache } from '../store/identity.js';
import { abbreviate, shortId } from './render.js';

/**
 * Abbreviations for every identifier in the store, computed once per run.
 *
 * Held here rather than threaded through a dozen signatures: it is derived from
 * the store, which does not change under a single invocation, and every screen
 * has to agree — an account that reads `9866b1e8` on one screen and `9866b1e8c4`
 * on the next is the sort of detail that makes people doubt they are looking at
 * the same thing.
 */
let names = new Map<string, string>();

export function short(id: string): string {
  return names.get(id) ?? shortId(id);
}

export function nameEverything(store: StoreLayout): void {
  useStoreForNames(store);
  const refs = [...listAccountDirs(store), ...listAgentAccountDirs(store)];
  // Accounts and organizations abbreviate independently: they are never compared
  // with each other, so a collision across the two kinds should not lengthen both.
  names = new Map([
    ...abbreviate(refs.map((ref) => ref.accountUuid)),
    ...abbreviate(refs.map((ref) => ref.organizationUuid)),
  ]);
}

/**
 * A source of account names other than labels: returns what it can name, keyed
 * by account uuid. Consulted after labels, in registration order, so a label a
 * person chose always wins and an earlier namer wins over a later one.
 */
export type AccountNamer = (ledger: Ledger) => ReadonlyMap<string, string>;

const namers: AccountNamer[] = [];

/** Adds a source of account names. Returns a function that removes it again. */
export function registerAccountNamer(namer: AccountNamer): () => void {
  namers.push(namer);
  return () => {
    const at = namers.indexOf(namer);
    if (at >= 0) namers.splice(at, 1);
  };
}

/**
 * The name each account goes by, for anything that prints one.
 *
 * A label is something a person sat down and chose, so it wins. Failing that,
 * whatever a registered namer knows (the built-in one reads the signed-in
 * account's e-mail out of the app's own cache) is a far better name than eight
 * hex digits.
 */
/**
 * The store the built-in namer reads, set once per run by whoever resolved it
 * (`context()` for a command, the interactive session for the menu).
 */
let namingStore: StoreLayout | undefined;
let cachedName: { root: string; names: ReadonlyMap<string, string> } | undefined;

export function useStoreForNames(store: StoreLayout): void {
  namingStore = store;
}

/**
 * The built-in namer: the signed-in account's e-mail (or display name), read at
 * rest from the app's own cache and never over the network. Read once per store
 * per run, because the read walks the app's web storage.
 */
function cachedIdentityNames(): ReadonlyMap<string, string> {
  if (!namingStore) return new Map();
  if (cachedName?.root === namingStore.root) return cachedName.names;
  const names = new Map<string, string>();
  try {
    const accountUuid = readConfig(namingStore).lastKnownAccountUuid;
    const identity = accountUuid ? readIdentityFromCache(namingStore, accountUuid) : undefined;
    const name = identity?.email ?? identity?.name;
    if (accountUuid && name) names.set(accountUuid, name);
  } catch {
    // Best effort: an unreadable cache names nobody, and the uuid still shows.
  }
  cachedName = { root: namingStore.root, names };
  return names;
}

export function labelsOf(ledger: Ledger): Map<string, string> {
  const state = project(ledger.read());
  const names = new Map<string, string>();
  for (const [accountUuid, name] of cachedIdentityNames()) names.set(accountUuid, name);
  for (const namer of [...namers].reverse()) {
    for (const [accountUuid, name] of namer(ledger)) names.set(accountUuid, name);
  }
  for (const [accountUuid, label] of state.labels) names.set(accountUuid, label);
  return names;
}

/**
 * Only the labels a person gave, for the two places where that distinction is
 * the subject: the prompt that offers to change one, and the `label` field in
 * JSON output, which promises what was named rather than what is known.
 */
export function manualLabelsOf(ledger: Ledger): Map<string, string> {
  return project(ledger.read()).labels;
}

/** Account and organization, using a human label for the account when one exists. */
export function describeRef(labels: Map<string, string>, ref: AccountRef): string {
  return `${labels.get(ref.accountUuid) ?? short(ref.accountUuid)} ${pc.dim('/ org')} ${short(
    ref.organizationUuid,
  )}`;
}
