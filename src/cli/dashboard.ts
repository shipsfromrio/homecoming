import { samePath, storeRootOfCopy } from '../domain/paths.js';
import type { AccountRef, StoreLayout } from '../domain/types.js';
import { inspectApp } from '../engine/safety.js';
import type { Ledger } from '../ledger/log.js';
import { listActive, project } from '../ledger/project.js';
import { overviewAccounts, type AccountOverview } from '../store/accounts.js';
import { VERSION } from '../version.js';
import type { Dashboard, DashboardAccount } from '../tui/ui.js';
import { formatDate, shortId } from './render.js';

/**
 * What the home screen needs: counts and labels. Transcript walks belong to
 * /status: they are too expensive to run every time the menu comes back.
 */
export function buildDashboard(
  store: StoreLayout,
  ledger: Ledger,
  target: AccountRef,
  // The caller can hand over rows it already computed — the scan behind them
  // reads every session file, so running it twice per screen is real money.
  rows: AccountOverview[] = overviewAccounts(store, ledger),
): Dashboard {
  const labels = project(ledger.read()).labels;
  const active = listActive(project(ledger.read()));
  const app = inspectApp(store);
  const signedLabel = labels.get(target.accountUuid) ?? shortId(target.accountUuid);

  const accounts: DashboardAccount[] = rows.map((row) => ({
    accountUuid: row.accountUuid,
    shortId: shortId(row.accountUuid),
    ...(row.label ? { label: row.label } : {}),
    // The identity itself, so an account homecoming has seen signed in never shows
    // as a bare uuid just because nobody gave it a label yet. The e-mail comes
    // first, as everywhere else: two accounts can answer to the same display
    // name — this machine has two called "<autor>" — and none can share an address.
    ...(row.identity?.email || row.identity?.name
      ? { identityName: row.identity.email ?? row.identity.name }
      : {}),
    isCurrent: row.isCurrent,
    // What a plugin's account decorator added. Absent without one, so the
    // screen is exactly what it was before decorators existed.
    ...(row.decoration?.marker ? { marker: row.decoration.marker } : {}),
    ...(row.decoration?.meta?.length ? { meta: row.decoration.meta } : {}),
    sessions: row.sessions,
    copies: row.copies,
  }));

  return {
    version: VERSION,
    store: store.root,
    signedIn: signedLabel,
    appRunning: app.running,
    accounts,
    fostered: active.map((item) => {
      const root = storeRootOfCopy(item.copyPath);
      const elsewhere = samePath(root, store.root) ? undefined : root;
      return {
        title: item.originalTitle || shortId(item.originSessionId),
        date: formatDate(item.fosteredAt),
        ...(elsewhere ? { elsewhere } : {}),
      };
    }),
  };
}
