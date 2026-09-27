import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_KEYED_PREFS,
  APP_PREFS,
  NEVER_CARRIED_ACCOUNT_PREFS,
  parsePrefValue,
  planAccountPrefsCarry,
  readAppPrefs,
  refuseGuarded,
  registerAppPrefAllowlist,
  specOf,
  writeAccountPrefsCarry,
  writeAppPref,
} from '../src/store/appPrefs.js';
import type { AccountRef, StoreLayout } from '../src/domain/types.js';
import { plannedChanges, registerAppPref, resolve } from '../src/cli/appPrefCommand.js';
import type * as Desktop from '../src/engine/desktop.js';
import type * as Safety from '../src/engine/safety.js';
import { makeStore } from './helpers/store.js';

/**
 * Doubles for the "--restart" end-to-end tests below. Nothing in this file may
 * close or launch the real Claude Desktop — `quitDesktop`/`startDesktop` are
 * stubbed the same way `tests/interactive.test.ts` stubs them, and
 * `inspectDesktopFor` (what `restartPlan` reads) is driven per test rather than
 * left to read the real process table.
 */
const desktop = vi.hoisted(() => ({
  quitDesktop: vi.fn(),
  startDesktop: vi.fn(),
  inspectDesktopFor: vi.fn(),
  hostedByDesktop: vi.fn(() => false),
}));

vi.mock('../src/engine/desktop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Desktop>();
  return {
    ...actual,
    quitDesktop: desktop.quitDesktop,
    startDesktop: desktop.startDesktop,
    inspectDesktopFor: desktop.inspectDesktopFor,
    hostedByDesktop: desktop.hostedByDesktop,
  };
});

const safety = vi.hoisted(() => ({ running: false }));
vi.mock('../src/engine/safety.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Safety>();
  return { ...actual, inspectApp: () => ({ running: safety.running, evidence: [] }) };
});

/**
 * The app's own settings, read and written where the app keeps them.
 *
 * What these pin down is mostly restraint: this file carries the MCP server list
 * and every other preference the app has, so a write that touches anything but
 * the one key asked for is the failure worth catching.
 */

function storeWith(settings: Record<string, unknown>): StoreLayout {
  const store = makeStore();
  writeFileSync(store.desktopConfigFile, JSON.stringify(settings), 'utf8');
  return store;
}

function settingsOf(store: StoreLayout): Record<string, unknown> {
  return JSON.parse(readFileSync(store.desktopConfigFile, 'utf8')) as Record<string, unknown>;
}

describe('the preference table', () => {
  it('gives every preference it knows a default', () => {
    const names = Object.keys(APP_PREFS);
    expect(names).toHaveLength(90);
    for (const name of names) expect(specOf(name)).toHaveProperty('fallback');
  });

  it('knows the three that decide what the app does to a Code session', () => {
    expect(APP_PREFS.ccBranchPrefix).toMatchObject({ kind: 'string', fallback: 'claude' });
    expect(APP_PREFS.ccMaxWarmWorktrees).toMatchObject({ kind: 'number', fallback: 3 });
    expect(APP_PREFS.ccWorktreeReapAfterHours).toMatchObject({ kind: 'number', fallback: 24 });
  });

  it('marks the settings the app guards', () => {
    expect(APP_PREFS.bypassPermissionsModeEnabled.guard).toBe(true);
    expect(APP_PREFS.bypassPermissionsGateByAccount.guard).toBe(true);
    expect(APP_PREFS.bypassPermissionsOptInByAccount.guard).toBe(true);
    expect(APP_PREFS.remoteFolderConsentMemory.guard).toBe(true);
    expect(APP_PREFS.simulatorDeviceConsent.guard).toBe(true);
    expect(APP_PREFS.allowAllBrowserActions.guard).toBe(true);
    expect(APP_PREFS.localAgentModeTrustedFolders.guard).toBe(true);
    expect(specOf('menuBarEnabled')?.guard).toBeUndefined();
  });

  it('guards organization policy, compliance and approval preferences', () => {
    // A name that records one of these is refused even if a later edit forgets
    // the flag: the table has to say so, and this pins the ones that do.
    const guarded = [
      'coworkHipaaRestricted',
      'orgWorkAcrossAppsDisabled',
      'wakeSchedulerApprovedThisCycle',
      'growthBookHybridAuthedOrigins',
    ];
    for (const name of guarded) expect(specOf(name)?.guard, name).toBe(true);
    const byName = Object.keys(APP_PREFS).filter((name) =>
      /hipaa|orgWork|Approved|AuthedOrigins/i.test(name),
    );
    expect(byName).toEqual(expect.arrayContaining(guarded));
    for (const name of byName) expect(specOf(name)?.guard, name).toBe(true);
  });

  it('guards every preference whose name records a bypass or a consent', () => {
    // A new build that adds one more of these must not land as writable by
    // default: the name alone is enough to put it behind the refusal.
    const names = Object.keys(APP_PREFS).filter((name) => /bypass|consent/i.test(name));
    expect(names.length).toBeGreaterThanOrEqual(5);
    for (const name of names) expect(specOf(name)?.guard, name).toBe(true);
  });
});

describe('readAppPrefs', () => {
  it('lists what somebody has set, and says so', () => {
    const store = storeWith({ preferences: { menuBarEnabled: false } });
    const rows = readAppPrefs(store);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'menuBarEnabled', value: false, stored: true });
  });

  it('falls back to the app default for everything nobody has touched', () => {
    const store = storeWith({ preferences: {} });
    const rows = readAppPrefs(store, true);

    const branch = rows.find((r) => r.name === 'ccBranchPrefix');
    expect(branch).toMatchObject({ value: 'claude', stored: false });
    expect(rows).toHaveLength(90);
  });

  it('still lists a stored preference this build has never heard of', () => {
    // The app adds settings whenever it likes. Dropping one because the table
    // does not know it would make this a worse witness than the file itself.
    const store = storeWith({ preferences: { somethingNewInTheNextRelease: 7 } });
    const rows = readAppPrefs(store);

    expect(rows[0]).toMatchObject({ name: 'somethingNewInTheNextRelease', value: 7, stored: true });
  });

  it('reads nothing rather than throwing when the file is not there', () => {
    expect(readAppPrefs(makeStore())).toEqual([]);
  });
});

describe('parsePrefValue', () => {
  it('takes only true or false for a boolean', () => {
    expect(parsePrefValue(APP_PREFS.menuBarEnabled, 'false')).toEqual({ ok: true, value: false });
    expect(parsePrefValue(APP_PREFS.menuBarEnabled, 'no')).toMatchObject({ ok: false });
  });

  it('takes a number, and refuses what is not one', () => {
    expect(parsePrefValue(APP_PREFS.ccMaxWarmWorktrees, '8')).toEqual({ ok: true, value: 8 });
    expect(parsePrefValue(APP_PREFS.ccMaxWarmWorktrees, 'many')).toMatchObject({ ok: false });
  });

  it('holds an enum to the values the app accepts', () => {
    expect(parsePrefValue(APP_PREFS.sidebarMode, 'code')).toEqual({ ok: true, value: 'code' });
    const refused = parsePrefValue(APP_PREFS.sidebarMode, 'sidebar');
    expect(refused).toMatchObject({ ok: false });
    if (!refused.ok) expect(refused.reason).toContain('chat');
  });

  it('takes JSON for the shapes a command line cannot spell', () => {
    expect(parsePrefValue(APP_PREFS.localAgentModeTrustedFolders, '["C:/work"]')).toEqual({
      ok: true,
      value: ['C:/work'],
    });
    expect(parsePrefValue(APP_PREFS.localAgentModeTrustedFolders, 'C:/work')).toMatchObject({
      ok: false,
    });
  });
});

describe('writeAppPref', () => {
  it('refuses a policy preference, and writes it only while a plugin allowlists that name', () => {
    const store = storeWith({ preferences: { coworkHipaaRestricted: true } });
    expect(() => writeAppPref(store, 'coworkHipaaRestricted', false)).toThrow(/refusing to write/);
    expect(settingsOf(store)).toMatchObject({
      preferences: { coworkHipaaRestricted: true },
    });

    const undo = registerAppPrefAllowlist({ name: 'test', keys: ['coworkHipaaRestricted'] });
    try {
      expect(() => writeAppPref(store, 'orgWorkAcrossAppsDisabled', false)).toThrow(
        /refusing to write/,
      );
      const { write } = writeAppPref(store, 'coworkHipaaRestricted', false);
      expect(write).toMatchObject({ name: 'coworkHipaaRestricted', from: true, to: false });
      expect(settingsOf(store)).toMatchObject({
        preferences: { coworkHipaaRestricted: false },
      });
    } finally {
      undo();
    }
    expect(() => writeAppPref(store, 'coworkHipaaRestricted', true)).toThrow(/refusing to write/);
  });

  it('changes one preference and leaves every neighbour exactly as it was', () => {
    const store = storeWith({
      mcpServers: { one: { command: 'node' } },
      preferences: {
        menuBarEnabled: true,
        // The shape that a PowerShell round trip was measured mangling: an ISO
        // string reserialised as `...71Z`, in a key nobody asked to touch.
        someTimestamp: '2026-08-26T17:05:32.710Z',
        ccBranchPrefix: 'claude',
      },
    });

    const { write, backup } = writeAppPref(store, 'menuBarEnabled', false);

    expect(write).toMatchObject({ name: 'menuBarEnabled', from: true, to: false, unset: false });
    const after = settingsOf(store);
    expect(after.mcpServers).toEqual({ one: { command: 'node' } });
    expect((after.preferences as Record<string, unknown>).someTimestamp).toBe(
      '2026-08-26T17:05:32.710Z',
    );
    expect((after.preferences as Record<string, unknown>).ccBranchPrefix).toBe('claude');
    expect((after.preferences as Record<string, unknown>).menuBarEnabled).toBe(false);
    expect(readFileSync(backup, 'utf8')).toContain('"menuBarEnabled":true');
  });

  it('adds the preferences object when the file has none', () => {
    const store = storeWith({ mcpServers: {} });

    writeAppPref(store, 'ccMaxWarmWorktrees', 8);

    expect(settingsOf(store).preferences).toEqual({ ccMaxWarmWorktrees: 8 });
  });

  it('reports the app default as the value it came from, when nothing was stored', () => {
    const store = storeWith({ preferences: {} });

    const { write } = writeAppPref(store, 'ccWorktreeReapAfterHours', 72);

    expect(write).toMatchObject({ from: 24, to: 72 });
  });

  it('unsets by removing the key, so the app default takes over again', () => {
    const store = storeWith({ preferences: { ccBranchPrefix: 'mine', menuBarEnabled: false } });

    const { write } = writeAppPref(store, 'ccBranchPrefix', undefined, { unset: true });

    expect(write).toMatchObject({ from: 'mine', to: 'claude', unset: true });
    const after = settingsOf(store).preferences as Record<string, unknown>;
    expect('ccBranchPrefix' in after).toBe(false);
    expect(after.menuBarEnabled).toBe(false);
  });

  it('refuses a guarded preference, set or unset, and leaves the file untouched', () => {
    const store = storeWith({ preferences: { menuBarEnabled: false } });
    const before = readFileSync(store.desktopConfigFile, 'utf8');

    for (const name of [
      'bypassPermissionsOptInByAccount',
      'bypassPermissionsGateByAccount',
      'remoteFolderConsentMemory',
      'simulatorDeviceConsent',
      'allowAllBrowserActions',
    ]) {
      expect(() => writeAppPref(store, name, { someone: true })).toThrow(/refusing to write/);
      expect(() => writeAppPref(store, name, undefined, { unset: true })).toThrow(
        /refusing to write/,
      );
    }
    expect(readFileSync(store.desktopConfigFile, 'utf8')).toBe(before);
  });

  it('refuses a batch that names any guarded preference', () => {
    expect(() => refuseGuarded(['menuBarEnabled', 'simulatorDeviceConsent'])).toThrow(
      /simulatorDeviceConsent/,
    );
    expect(() => refuseGuarded(['menuBarEnabled', 'ccBranchPrefix'])).not.toThrow();
  });

  it('refuses on a lossy number literal elsewhere in the file, same guard groupScopes/viewPrefs carry', () => {
    // Previously missing here (this file used its own hand-rolled write
    // instead of the shared rewriteDesktopConfig): a `JSON.parse`/`stringify`
    // round trip would have silently rewritten this trailing `.0`, invisible
    // to the "did a neighbour move" check because both trees it compares are
    // already-lossy parses.
    const store = storeWith({ preferences: {} });
    writeFileSync(
      store.desktopConfigFile,
      '{"preferences":{"menuBarEnabled":true},"scale":1.0}',
      'utf8',
    );

    expect(() => writeAppPref(store, 'menuBarEnabled', false)).toThrow(/1\.0/);
    expect(readFileSync(store.desktopConfigFile, 'utf8')).toBe(
      '{"preferences":{"menuBarEnabled":true},"scale":1.0}',
    );
  });

  it('backs up outside the app store, under ~/.foster/backups — never next to the file it copies', () => {
    const store = storeWith({ preferences: { menuBarEnabled: true } });
    const home = path.join(store.root, '.foster-home');

    const { backup } = writeAppPref(store, 'menuBarEnabled', false, {
      env: { ...process.env, FOSTER_HOME: home },
    });

    expect(path.dirname(backup)).not.toBe(path.dirname(store.desktopConfigFile));
    expect(backup).toMatch(/backups/);
  });

  it('two writes landing in the same backup-directory second each keep their own backup', () => {
    // The old scheme named the backup `<file>.bak-<minute-resolution stamp>`,
    // next to the file itself: a second writeAppPref within the same minute
    // silently overwrote the first "backup" with the file the first write had
    // already changed, losing the true original.
    const store = storeWith({ preferences: { ccBranchPrefix: 'first' } });
    const home = path.join(store.root, '.foster-home');
    const env = { ...process.env, FOSTER_HOME: home };
    const now = () => new Date('2026-09-24T10:00:00.000Z');

    const first = writeAppPref(store, 'ccBranchPrefix', 'second', { env, now });
    const second = writeAppPref(store, 'ccBranchPrefix', 'third', { env, now });

    expect(first.backup).not.toBe(second.backup);
    // first.backup is the byte-for-byte original (compact, as `storeWith`
    // wrote it); second.backup is a copy of what the first write left behind
    // (pretty-printed by writeFileAtomic) — either way, each write's backup
    // holds the value from just before *that* write, not the other's.
    expect(readFileSync(first.backup, 'utf8')).toContain('"ccBranchPrefix":"first"');
    expect(readFileSync(second.backup, 'utf8')).toContain('"ccBranchPrefix": "second"');
  });

  it('takes an env option without also needing a now, defaulting the clock itself', () => {
    // BackupOptions carries both `env` and `now`; a caller that only redirects
    // FOSTER_HOME (this test, so it never touches the real one) still gets a
    // working backup without picking a clock.
    const store = storeWith({ preferences: { menuBarEnabled: true } });
    const home = path.join(store.root, '.foster-home');

    const { backup } = writeAppPref(store, 'menuBarEnabled', false, {
      env: { ...process.env, FOSTER_HOME: home },
    });

    expect(readdirSync(path.dirname(backup))).toContain(path.basename(backup));
  });
});

describe('what a command line asks to change', () => {
  it('takes the positional pair', () => {
    expect(plannedChanges('sidebarMode', 'code', undefined, false)).toEqual([
      { name: 'sidebarMode', value: 'code', unset: false },
    ]);
  });

  it('takes several --set, so one stop of the app covers them all', () => {
    expect(
      plannedChanges(
        undefined,
        undefined,
        ['keepAwakeEnabled=true', 'ccMaxWarmWorktrees=6'],
        false,
      ),
    ).toEqual([
      { name: 'keepAwakeEnabled', value: 'true', unset: false },
      { name: 'ccMaxWarmWorktrees', value: '6', unset: false },
    ]);
  });

  it('keeps everything after the first = as the value', () => {
    // A branch prefix, a device name or a path can hold one.
    expect(plannedChanges(undefined, undefined, ['ccBranchPrefix=team=a/b'], false)).toEqual([
      { name: 'ccBranchPrefix', value: 'team=a/b', unset: false },
    ]);
  });

  it('reads a bare name with --unset as a change, not a read', () => {
    expect(plannedChanges('ccBranchPrefix', undefined, undefined, true)).toEqual([
      { name: 'ccBranchPrefix', unset: true },
    ]);
  });

  it('asks for nothing when the name is there to be read', () => {
    expect(plannedChanges('sidebarMode', undefined, undefined, false)).toEqual([]);
  });

  it('refuses a --set that is not name=value', () => {
    expect(() => plannedChanges(undefined, undefined, ['keepAwakeEnabled'], false)).toThrow(
      /name=value/,
    );
    expect(() => plannedChanges(undefined, undefined, ['=true'], false)).toThrow(/name=value/);
  });
});

describe('resolving a change before the app is touched', () => {
  it('refuses an unknown preference', () => {
    const store = storeWith({ preferences: {} });
    expect(() => resolve(store, { name: 'notAThing', value: '1', unset: false })).toThrow(
      /not a preference/,
    );
  });

  it('refuses a value the app would reject, naming what it takes', () => {
    // The reason this happens here rather than after the app is closed: a typo
    // in the third of three values must not be found with the app already down.
    const store = storeWith({ preferences: {} });
    expect(() => resolve(store, { name: 'sidebarMode', value: 'sidebar', unset: false })).toThrow(
      /chat/,
    );
  });

  it('carries the current value and the one it would land on', () => {
    const store = storeWith({ preferences: { ccMaxWarmWorktrees: 3 } });
    expect(resolve(store, { name: 'ccMaxWarmWorktrees', value: '6', unset: false })).toMatchObject({
      from: 3,
      to: 6,
      parsed: 6,
    });
  });
});

/**
 * `--restart`, driven through the actual CLI action, not just the pure
 * helpers above. Three bugs lived here until this went through
 * `restartAround` (`src/ops/restart.ts`) the same way `layout`/`view` do:
 * a write that threw after `quitDesktop` succeeded left `startDesktop` never
 * called at all; the tray refusal told the user to "Re-run with --terminate",
 * a flag this command has never had; and `startDesktop`'s own result was
 * thrown away, so it printed "is up" whether or not it actually was.
 */
describe('the --restart write, through the real CLI action', () => {
  beforeEach(() => {
    desktop.quitDesktop.mockReset().mockResolvedValue({ outcome: 'quit' });
    desktop.startDesktop.mockReset().mockResolvedValue(true);
    desktop.inspectDesktopFor
      .mockReset()
      .mockReturnValue({ running: true, codeSessions: 0, selfHosted: false });
    desktop.hostedByDesktop.mockReset().mockReturnValue(false);
    safety.running = true;
  });

  function appFor(store: StoreLayout): Command {
    const app = new Command();
    app.exitOverride();
    registerAppPref(app, () => ({ store }));
    return app;
  }

  async function run(store: StoreLayout, args: string[]): Promise<string> {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      await appFor(store).parseAsync(args, { from: 'user' });
    } finally {
      spy.mockRestore();
    }
    return lines.join('\n');
  }

  it('quits, writes, starts the app back up, and reports the write', async () => {
    const store = storeWith({ preferences: { menuBarEnabled: true } });

    const output = await run(store, ['pref', 'menuBarEnabled', 'false', '--restart', '--yes']);

    expect(desktop.quitDesktop).toHaveBeenCalledOnce();
    expect(desktop.startDesktop).toHaveBeenCalledOnce();
    expect((settingsOf(store).preferences as Record<string, unknown>).menuBarEnabled).toBe(false);
    expect(output).toContain('Claude Desktop is up.');
  });

  it('still starts the app back up when the write throws, instead of leaving it closed silently', async () => {
    // A bare store with no claude_desktop_config.json at all: writeAppPref's
    // own readFileSync throws ENOENT the first time it is called, inside
    // restartAround's duringGap — a real throw, not a mocked one.
    const store = makeStore();
    process.exitCode = undefined;

    const output = await run(store, ['pref', 'menuBarEnabled', 'false', '--restart', '--yes']);

    expect(desktop.quitDesktop).toHaveBeenCalledOnce();
    // The bug: `startDesktop` used to never run at all here.
    expect(desktop.startDesktop).toHaveBeenCalledOnce();
    expect(output).not.toContain('Claude Desktop is up.');
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it('reports closed: true when the (only) write throws inside the gap, because the app really was closed', async () => {
    // Same ENOENT-throwing store as above, but --json and a single change —
    // so `written` stays empty (the throw happens before anything is pushed
    // onto it). The old bug used `written.length > 0` as a proxy for "the app
    // was closed", which is wrong here: `quitDesktop` above resolved 'quit'
    // before `writeAppPref` ever ran, so the app was closed regardless of
    // whether the write itself landed.
    const store = makeStore();
    process.exitCode = undefined;

    const output = await run(store, [
      'pref',
      'menuBarEnabled',
      'false',
      '--restart',
      '--yes',
      '--json',
    ]);

    expect(desktop.quitDesktop).toHaveBeenCalledOnce();
    const parsed = JSON.parse(output) as { written: unknown[]; closed: boolean };
    expect(parsed.written).toHaveLength(0);
    expect(parsed.closed).toBe(true);
    process.exitCode = undefined;
  });

  it('names "homecoming app quit --terminate" when the tray is in the way, never the wrong "--terminate" flag', async () => {
    desktop.quitDesktop.mockResolvedValue({ outcome: 'needs-terminate', mainPid: 4242 });
    const store = storeWith({ preferences: { menuBarEnabled: true } });
    process.exitCode = undefined;

    const output = await run(store, ['pref', 'menuBarEnabled', 'false', '--restart', '--yes']);

    // The old bug: this command has no --terminate option of its own, so
    // "Re-run with --terminate" sent the user to an unknown option.
    expect(output).not.toContain('Re-run with --terminate');
    expect(output).toContain('homecoming app quit --terminate');
    expect(desktop.startDesktop).not.toHaveBeenCalled();
    expect((settingsOf(store).preferences as Record<string, unknown>).menuBarEnabled).toBe(true);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });
});

describe('account-uuid-keyed app prefs carry', () => {
  const TARGET: AccountRef = {
    accountUuid: '11111111-1111-4111-8111-111111111111',
    organizationUuid: '11111111-1111-4111-8111-111111111112',
  };
  const SOURCE: AccountRef = {
    accountUuid: '00000000-0000-4000-8000-000000000001',
    organizationUuid: '00000000-0000-4000-8000-000000000002',
  };
  const env = (store: StoreLayout) => ({
    ...process.env,
    FOSTER_HOME: path.join(store.root, '.foster-home'),
  });

  function writeConfig(store: StoreLayout, preferences: Record<string, unknown>): void {
    writeFileSync(store.desktopConfigFile, JSON.stringify({ preferences }), 'utf8');
  }

  it('carries the source’s entry when the target has none', () => {
    const store = makeStore();
    writeConfig(store, { coworkModelAutoFallbackByAccount: { [SOURCE.accountUuid]: 'sonnet' } });

    const plan = planAccountPrefsCarry(store, TARGET, SOURCE);
    expect(plan.changes).toEqual({ coworkModelAutoFallbackByAccount: 'sonnet' });

    writeAccountPrefsCarry(store, TARGET, plan.changes, { env: env(store) });
    const written = JSON.parse(readFileSync(store.desktopConfigFile, 'utf8')) as {
      preferences: Record<string, Record<string, unknown>>;
    };
    expect(written.preferences.coworkModelAutoFallbackByAccount).toEqual({
      [SOURCE.accountUuid]: 'sonnet',
      [TARGET.accountUuid]: 'sonnet',
    });
  });

  it.each(NEVER_CARRIED_ACCOUNT_PREFS)(
    'never plans %s: a permission-bypass consent is not inherited by another account',
    (name) => {
      const store = makeStore();
      writeConfig(store, {
        [name]: { [SOURCE.accountUuid]: true },
        coworkModelAutoFallbackByAccount: { [SOURCE.accountUuid]: 'sonnet' },
      });

      const plan = planAccountPrefsCarry(store, TARGET, SOURCE);
      expect(plan.changes).not.toHaveProperty(name);
      expect(Object.keys(plan.changes)).toEqual(['coworkModelAutoFallbackByAccount']);
    },
  );

  it.each(NEVER_CARRIED_ACCOUNT_PREFS)(
    'refuses to write %s even when a caller hands it in, and leaves the file alone',
    (name) => {
      const store = makeStore();
      writeConfig(store, { [name]: { [SOURCE.accountUuid]: true } });
      const before = readFileSync(store.desktopConfigFile, 'utf8');

      expect(() =>
        writeAccountPrefsCarry(store, TARGET, { [name]: true }, { env: env(store) }),
      ).toThrow(/never inherited/);
      expect(readFileSync(store.desktopConfigFile, 'utf8')).toBe(before);
    },
  );

  it('carries none of the permission-bypass maps', () => {
    for (const name of NEVER_CARRIED_ACCOUNT_PREFS) {
      expect(ACCOUNT_KEYED_PREFS as readonly string[]).not.toContain(name);
    }
  });

  it('leaves the target alone when it already has its own entry', () => {
    const store = makeStore();
    writeConfig(store, {
      coworkModelAutoFallbackByAccount: {
        [SOURCE.accountUuid]: 'sonnet',
        [TARGET.accountUuid]: 'opus',
      },
    });

    const plan = planAccountPrefsCarry(store, TARGET, SOURCE);
    expect(plan.changes).toEqual({});
  });

  it('carries nothing when there is no source at all', () => {
    const store = makeStore();
    writeConfig(store, { coworkModelAutoFallbackByAccount: { [SOURCE.accountUuid]: 'sonnet' } });
    const plan = planAccountPrefsCarry(store, TARGET, undefined);
    expect(plan.changes).toEqual({});
  });

  it('carries nothing when the source has no entry of its own either', () => {
    const store = makeStore();
    writeConfig(store, { coworkModelAutoFallbackByAccount: {} });
    const plan = planAccountPrefsCarry(store, TARGET, SOURCE);
    expect(plan.changes).toEqual({});
  });
});
