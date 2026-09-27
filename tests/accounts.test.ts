import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import { overviewAccounts } from '../src/store/accounts.js';
import { Ledger } from '../src/ledger/log.js';
import type { StoreLayout } from '../src/domain/types.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT } from './helpers/store.js';
import { renderAccount } from '../src/cli/render.js';

let store: StoreLayout;
let ledger: Ledger;

function makeLedger(): Ledger {
  return new Ledger(
    path.join(mkdtempSync(path.join(tmpdir(), 'homecoming-ledger-')), 'ledger.jsonl'),
  );
}

/** Creates the account/organization directories the app would create. */
function accountDir(accountUuid: string, organizationUuid: string) {
  mkdirSync(path.join(store.codeSessionsDir, accountUuid, organizationUuid), { recursive: true });
}

function signedInAs(accountUuid: string) {
  writeFileSync(store.configFile, JSON.stringify({ lastKnownAccountUuid: accountUuid }), 'utf8');
}

function cachedProfile(accountUuid: string) {
  const dir = path.join(store.root, 'Cache', 'Cache_Data');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `f_${accountUuid.slice(0, 6)}`),
    gzipSync(
      JSON.stringify({
        account: { uuid: accountUuid, full_name: 'John', email: 'john@example.com' },
      }),
    ),
  );
}

beforeEach(() => {
  store = makeStore();
  ledger = makeLedger();
});

describe('overviewAccounts', () => {
  it('reads the account in use fresh, from its own profile', () => {
    accountDir(OLD_ACCOUNT.accountUuid, OLD_ACCOUNT.organizationUuid);
    signedInAs(OLD_ACCOUNT.accountUuid);
    cachedProfile(OLD_ACCOUNT.accountUuid);

    const [row] = overviewAccounts(store, ledger);
    expect(row).toMatchObject({ accountUuid: OLD_ACCOUNT.accountUuid, isCurrent: true });
    expect(row!.identity).toEqual({ email: 'john@example.com', name: 'John' });
    expect(row!.remembered).toBe(false);
  });

  it('does not answer for another account out of the current account’s profile', () => {
    // The response cache describes one session. Handing its answer to a second
    // account would be worse than saying nothing: every account would read as
    // the same person, and the screen exists precisely to tell them apart.
    accountDir(OLD_ACCOUNT.accountUuid, OLD_ACCOUNT.organizationUuid);
    accountDir(NEW_ACCOUNT.accountUuid, NEW_ACCOUNT.organizationUuid);
    signedInAs(OLD_ACCOUNT.accountUuid);
    cachedProfile(OLD_ACCOUNT.accountUuid);

    const rows = overviewAccounts(store, ledger);
    const other = rows.find((row) => row.accountUuid === NEW_ACCOUNT.accountUuid);
    expect(other?.identity).toBeUndefined();
  });

  it('counts sessions and copies per account', () => {
    accountDir(OLD_ACCOUNT.accountUuid, OLD_ACCOUNT.organizationUuid);
    const [row] = overviewAccounts(store, ledger);
    expect(row).toMatchObject({ sessions: 0, copies: 0, agentOnly: false });
    expect(row!.organizationUuids).toEqual([OLD_ACCOUNT.organizationUuid]);
  });

  it('includes an account that only has a Cowork tree', () => {
    // Cowork creates the tree before any Code session exists, so leaving these
    // out would hide the account someone is signed into right now.
    mkdirSync(
      path.join(store.agentSessionsDir, NEW_ACCOUNT.accountUuid, NEW_ACCOUNT.organizationUuid),
      { recursive: true },
    );

    const rows = overviewAccounts(store, ledger);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ accountUuid: NEW_ACCOUNT.accountUuid, agentOnly: true });
  });

  it('does not mistake a plugin directory for an account', () => {
    // `skills-plugin` sits beside the accounts in the Cowork tree with the same
    // shape. An account nobody can sign into is not an account.
    mkdirSync(path.join(store.agentSessionsDir, 'skills-plugin', 'anything'), { recursive: true });

    expect(overviewAccounts(store, ledger)).toHaveLength(0);
  });

  it('puts the account in use first', () => {
    accountDir(OLD_ACCOUNT.accountUuid, OLD_ACCOUNT.organizationUuid);
    accountDir(NEW_ACCOUNT.accountUuid, NEW_ACCOUNT.organizationUuid);
    signedInAs(NEW_ACCOUNT.accountUuid);

    expect(overviewAccounts(store, ledger)[0]?.accountUuid).toBe(NEW_ACCOUNT.accountUuid);
  });

  it('carries the label through', () => {
    accountDir(OLD_ACCOUNT.accountUuid, OLD_ACCOUNT.organizationUuid);
    ledger.append({
      kind: 'account_labelled',
      accountUuid: OLD_ACCOUNT.accountUuid,
      label: 'work',
    });

    expect(overviewAccounts(store, ledger)[0]?.label).toBe('work');
  });
});

describe('renderAccount', () => {
  it('says who the account is and what is on disk for it', () => {
    const lines = renderAccount({
      accountUuid: OLD_ACCOUNT.accountUuid,
      organizationUuids: [OLD_ACCOUNT.organizationUuid],
      isCurrent: true,
      sessions: 3,
      copies: 1,
      agentOnly: false,
      identity: { email: 'john@example.com', name: 'John' },
      remembered: false,
    });

    const text = lines.join('\n');
    expect(text).toContain('John · john@example.com');
    expect(text).toContain('3 session(s), 1 fostered copy(s)');
  });

  it('asks for the app to be opened when the account in use has nothing cached', () => {
    const lines = renderAccount({
      accountUuid: OLD_ACCOUNT.accountUuid,
      organizationUuids: [OLD_ACCOUNT.organizationUuid],
      isCurrent: true,
      sessions: 0,
      copies: 0,
      agentOnly: false,
      remembered: false,
    });

    expect(lines.join('\n')).toContain('nothing cached for this account yet');
  });
});
