import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StoreLayout } from '../src/domain/types.js';
import {
  planAccountPrefsCarry,
  registerAccountPrefCarryAllowlist,
  writeAccountPrefsCarry,
} from '../src/store/appPrefs.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT } from './helpers/store.js';

/**
 * Carry allowlists: more account-keyed preferences `layout` copies from the
 * most recently active other account. A never-carried preference (a safety
 * consent) travels only when an allowlist names it, and only while it does.
 */

const CONSENT = 'bypassPermissionsOptInByAccount';
const EXTRA = 'someFeatureByAccount';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function storeWith(preferences: Record<string, unknown>): StoreLayout {
  const store = makeStore();
  writeFileSync(store.desktopConfigFile, JSON.stringify({ preferences }), 'utf8');
  return store;
}

function preferencesOf(store: StoreLayout): Record<string, Record<string, unknown>> {
  return (
    JSON.parse(readFileSync(store.desktopConfigFile, 'utf8')) as {
      preferences: Record<string, Record<string, unknown>>;
    }
  ).preferences;
}

const backupEnv = (store: StoreLayout) => ({
  env: { ...process.env, FOSTER_HOME: path.join(store.root, '.foster-home') },
});

describe('account pref carry allowlists', () => {
  it('without one, an unknown account-keyed preference is not planned', () => {
    const store = storeWith({ [EXTRA]: { [OLD_ACCOUNT.accountUuid]: 'on' } });
    expect(planAccountPrefsCarry(store, NEW_ACCOUNT, OLD_ACCOUNT).changes).toEqual({});
  });

  it('a registered key is planned and carried', () => {
    const store = storeWith({ [EXTRA]: { [OLD_ACCOUNT.accountUuid]: 'on' } });
    cleanups.push(registerAccountPrefCarryAllowlist({ name: 'example', keys: [EXTRA] }));

    const plan = planAccountPrefsCarry(store, NEW_ACCOUNT, OLD_ACCOUNT);
    expect(plan.changes).toEqual({ [EXTRA]: 'on' });
    writeAccountPrefsCarry(store, NEW_ACCOUNT, plan.changes, backupEnv(store));

    expect(preferencesOf(store)[EXTRA]).toEqual({
      [OLD_ACCOUNT.accountUuid]: 'on',
      [NEW_ACCOUNT.accountUuid]: 'on',
    });
  });

  it('a never-carried preference is refused without an allowlist naming it', () => {
    const store = storeWith({ [CONSENT]: { [OLD_ACCOUNT.accountUuid]: true } });
    cleanups.push(registerAccountPrefCarryAllowlist({ name: 'example', keys: [EXTRA] }));

    expect(planAccountPrefsCarry(store, NEW_ACCOUNT, OLD_ACCOUNT).changes).toEqual({});
    expect(() =>
      writeAccountPrefsCarry(store, NEW_ACCOUNT, { [CONSENT]: true }, backupEnv(store)),
    ).toThrow(/refusing to copy bypassPermissionsOptInByAccount/);
    expect(preferencesOf(store)[CONSENT]).toEqual({ [OLD_ACCOUNT.accountUuid]: true });
  });

  it('a never-carried preference passes when an allowlist names it', () => {
    const store = storeWith({ [CONSENT]: { [OLD_ACCOUNT.accountUuid]: true } });
    cleanups.push(registerAccountPrefCarryAllowlist({ name: 'example', keys: [CONSENT] }));

    const plan = planAccountPrefsCarry(store, NEW_ACCOUNT, OLD_ACCOUNT);
    expect(plan.changes).toEqual({ [CONSENT]: true });
    writeAccountPrefsCarry(store, NEW_ACCOUNT, plan.changes, backupEnv(store));
    expect(preferencesOf(store)[CONSENT]?.[NEW_ACCOUNT.accountUuid]).toBe(true);
  });

  it('naming one never-carried preference does not open the other', () => {
    const store = storeWith({});
    cleanups.push(registerAccountPrefCarryAllowlist({ name: 'example', keys: [CONSENT] }));

    expect(() =>
      writeAccountPrefsCarry(
        store,
        NEW_ACCOUNT,
        { bypassPermissionsGateByAccount: true },
        backupEnv(store),
      ),
    ).toThrow(/refusing to copy bypassPermissionsGateByAccount/);
  });

  it('unregistering refuses again, even for a plan made while it was registered', () => {
    const store = storeWith({ [CONSENT]: { [OLD_ACCOUNT.accountUuid]: true } });
    const undo = registerAccountPrefCarryAllowlist({ name: 'example', keys: [CONSENT] });
    const plan = planAccountPrefsCarry(store, NEW_ACCOUNT, OLD_ACCOUNT);
    undo();

    expect(planAccountPrefsCarry(store, NEW_ACCOUNT, OLD_ACCOUNT).changes).toEqual({});
    expect(() =>
      writeAccountPrefsCarry(store, NEW_ACCOUNT, plan.changes, backupEnv(store)),
    ).toThrow(/refusing to copy/);
    expect(preferencesOf(store)[CONSENT]).toEqual({ [OLD_ACCOUNT.accountUuid]: true });
  });
});
