import pc from 'picocolors';
import type { AccountRef, StoreLayout } from '../domain/types.js';
import { listAccountDirs, samePath, storeRootOfCopy } from '../domain/paths.js';
import { continuedSince } from '../engine/continued.js';
import { findDuplicates } from '../engine/duplicates.js';
import type { Ledger } from '../ledger/log.js';
import { copySessionIds, listActive, project } from '../ledger/project.js';
import { type AccountOverview } from '../store/accounts.js';
import { scanAccount, summariseAccount } from '../store/scanner.js';
import type { Ui } from '../tui/ui.js';
import { labelsOf } from './names.js';
import { accountTree, formatDate, groupByAccount, renderAccount, shortId } from './render.js';

export function showStatus(ui: Ui, ledger: Ledger, store: StoreLayout): void {
  const active = listActive(project(ledger.read()));
  if (active.length === 0) {
    ui.log.info('Nothing is fostered.');
    return;
  }

  // Where a copy lives is said whenever it is not here. On the ordinary
  // single-profile setup that is never, so nothing is added; the earlier rule
  // asked whether the copies were *spread* across installations, which stayed
  // silent in the one case that misleads — every copy in the other profile,
  // reading exactly like copies in this one.
  // A conversation that carried on since it was fostered is worth marking: the
  // row in the original account still shows the date it had that day, and left
  // unsaid the difference only surfaces as a scare after a return.
  const continued = new Set(continuedSince(store, active).map((c) => c.fostering.copySessionId));

  const duplicates = findDuplicates(store, active);
  if (duplicates.copies.length > 0) {
    ui.log.warn(
      `${duplicates.copies.length} of these duplicate a conversation this account already had. ` +
        '"Send them back" offers to remove just those.',
    );
  }
  if (duplicates.branches.length > 0) {
    ui.log.warn(
      `${duplicates.branches.length} of these are branches of a conversation this account already had. ` +
        'Same work, forked: each side holds turns the other never got.',
    );
  }
  if (duplicates.appMade > 0) {
    ui.log.info(
      pc.dim(
        `${duplicates.appMade} conversation(s) here have more than one card the app itself made. ` +
          'homecoming did not write those and will not remove them.',
      ),
    );
  }

  ui.note(
    active
      .map((f) => {
        const root = storeRootOfCopy(f.copyPath);
        const where = samePath(root, store.root) ? '' : pc.dim(`  → ${root}`);
        const carried = continued.has(f.copySessionId) ? pc.dim('  (continued since)') : '';
        return `${pc.dim(formatDate(f.fosteredAt))}  ${f.originalTitle || shortId(f.originSessionId)}${carried}${where}`;
      })
      .join('\n'),
    `${active.length} fostered`,
  );
}

export function showAccounts(ui: Ui, store: StoreLayout, ledger: Ledger, target: AccountRef): void {
  const copies = copySessionIds(ledger.read());
  const rows = listAccountDirs(store).map((account) =>
    summariseAccount(account, scanAccount(store, account, copies), target.accountUuid),
  );
  ui.note(accountTree(groupByAccount(rows), labelsOf(ledger)), 'Accounts and their organizations');
}

/**
 * One account, in full — the dashboard cursor's "who is this?".
 *
 * The same rendering `accounts` uses for the whole list, for one row, so the
 * two screens can never drift apart on what a field means. The rows arrive
 * from the caller — the dashboard just computed them, and the scan behind
 * them reads every session file, so this screen must not run it again.
 */
export function showAccountDetails(
  ui: Ui,
  ledger: Ledger,
  rows: AccountOverview[],
  accountUuid: string,
): void {
  const row = rows.find((r) => r.accountUuid === accountUuid);
  if (!row) {
    ui.log.info('That account is no longer in this installation.');
    return;
  }
  ui.note(renderAccount(row).join('\n'), row.label ?? shortId(accountUuid));
}
