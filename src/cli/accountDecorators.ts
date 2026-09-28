import type { StoreLayout } from '../domain/types.js';
import type { Ledger } from '../ledger/log.js';
import type { AccountOverview } from '../store/accounts.js';

/** Removes what a `register*` call added. */
type Unregister = () => void;

/**
 * What a plugin adds to how one account is shown.
 *
 * - `marker`: a short tag after the account's name on the home screen.
 * - `meta`: short facts shown beside the counts on the home screen.
 * - `detailLines`: further lines in the account's detail view.
 *
 * Every part is optional and purely presentational: the core never reads a
 * decoration to decide anything.
 */
export interface AccountDecoration {
  marker?: string;
  meta?: readonly string[];
  detailLines?: readonly string[];
}

/**
 * Something to say about an account on screen. Returning nothing leaves the
 * account as the core shows it; one that throws is skipped for that account.
 */
export type AccountDecorator = (
  account: AccountOverview,
  context: { store: StoreLayout; ledger: Ledger },
) => AccountDecoration | undefined;

const decorators: AccountDecorator[] = [];

/** Adds an account decorator. Returns a function that removes it again. */
export function registerAccountDecorator(decorator: AccountDecorator): Unregister {
  decorators.push(decorator);
  return () => {
    const at = decorators.indexOf(decorator);
    if (at >= 0) decorators.splice(at, 1);
  };
}

/**
 * Every registered decorator's contribution for one account, merged in
 * registration order: the first marker wins, meta and detail lines accumulate.
 * Undefined when no decorator had anything to say, so a row nobody decorated
 * carries no `decoration` field at all.
 */
export function decorateAccount(
  account: AccountOverview,
  context: { store: StoreLayout; ledger: Ledger },
): AccountDecoration | undefined {
  if (decorators.length === 0) return undefined;
  let marker: string | undefined;
  const meta: string[] = [];
  const detailLines: string[] = [];
  for (const decorator of decorators) {
    let found: AccountDecoration | undefined;
    try {
      found = decorator(account, context);
    } catch {
      continue;
    }
    if (!found) continue;
    if (!marker && typeof found.marker === 'string' && found.marker) marker = found.marker;
    meta.push(...(found.meta ?? []).filter((item) => typeof item === 'string' && item !== ''));
    detailLines.push(...(found.detailLines ?? []).filter((line) => typeof line === 'string'));
  }
  if (!marker && meta.length === 0 && detailLines.length === 0) return undefined;
  return {
    ...(marker ? { marker } : {}),
    ...(meta.length > 0 ? { meta } : {}),
    ...(detailLines.length > 0 ? { detailLines } : {}),
  };
}
