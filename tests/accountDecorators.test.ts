import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerAccountDecorator } from '../src/cli/accountDecorators.js';
import { buildDashboard } from '../src/cli/dashboard.js';
import { renderAccount } from '../src/cli/render.js';
import { Ledger } from '../src/ledger/log.js';
import { overviewAccounts } from '../src/store/accounts.js';
import { renderHome } from '../src/tui/home.js';
import { FOSTER_NIGHT } from '../src/tui/theme.js';
import { stripAnsi } from '../src/tui/widgets.js';
import type { StoreLayout } from '../src/domain/types.js';
import { makeStore, OLD_ACCOUNT } from './helpers/store.js';

/**
 * Account decorators: what a plugin adds to how an account is shown. The home
 * screen gets a marker and meta, the detail view gets lines, and with no
 * decorator every screen is exactly what it was.
 */

let store: StoreLayout;
let ledger: Ledger;
let undo: (() => void)[] = [];

beforeEach(() => {
  store = makeStore();
  ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'homecoming-deco-')), 'l.jsonl'));
  mkdirSync(
    path.join(store.codeSessionsDir, OLD_ACCOUNT.accountUuid, OLD_ACCOUNT.organizationUuid),
    {
      recursive: true,
    },
  );
  writeFileSync(
    store.configFile,
    JSON.stringify({ lastKnownAccountUuid: OLD_ACCOUNT.accountUuid }),
    'utf8',
  );
  undo = [];
});

afterEach(() => {
  for (const step of undo.reverse()) step();
});

function screens() {
  const rows = overviewAccounts(store, ledger);
  const dashboard = buildDashboard(store, ledger, OLD_ACCOUNT, rows);
  const home = stripAnsi(renderHome(dashboard, [], FOSTER_NIGHT, 'none', 100, 24).join('\n'));
  const detail = renderAccount(rows[0]!).map(stripAnsi);
  return { rows, dashboard, home, detail };
}

describe('account decorators', () => {
  it('put their marker and meta on the dashboard row and the home line', () => {
    undo.push(
      registerAccountDecorator((account, context) => {
        expect(context.store).toBe(store);
        return account.isCurrent ? { marker: '[main]', meta: ['alpha', 'beta'] } : undefined;
      }),
    );

    const { rows, dashboard, home } = screens();
    expect(rows[0]?.decoration).toEqual({ marker: '[main]', meta: ['alpha', 'beta'] });
    expect(dashboard.accounts[0]).toMatchObject({ marker: '[main]', meta: ['alpha', 'beta'] });
    const line = home.split('\n').find((text) => text.includes('[main]'));
    expect(line).toBeDefined();
    expect(line).toContain('alpha · beta');
  });

  it('add detail lines to renderAccount', () => {
    undo.push(registerAccountDecorator(() => ({ detailLines: ['extra    one', 'extra    two'] })));

    const { detail } = screens();
    expect(detail.slice(-2)).toEqual(['  extra    one', '  extra    two']);
  });

  it('that throw are ignored, and the others still apply', () => {
    undo.push(
      registerAccountDecorator(() => {
        throw new Error('broken');
      }),
    );
    undo.push(registerAccountDecorator(() => ({ marker: '[ok]' })));

    const { dashboard } = screens();
    expect(dashboard.accounts[0]?.marker).toBe('[ok]');
  });

  it('leave every screen byte for byte as it was when none is registered, or after unregistering', () => {
    const before = screens();
    expect(before.rows[0]).not.toHaveProperty('decoration');
    expect(before.dashboard.accounts[0]).not.toHaveProperty('marker');
    expect(before.dashboard.accounts[0]).not.toHaveProperty('meta');

    const off = registerAccountDecorator(() => ({
      marker: '[x]',
      meta: ['m'],
      detailLines: ['d'],
    }));
    const during = screens();
    expect(during.home).not.toBe(before.home);
    off();

    const after = screens();
    expect(after.home).toBe(before.home);
    expect(after.detail).toEqual(before.detail);
    expect(after.dashboard).toEqual(before.dashboard);
  });
});
