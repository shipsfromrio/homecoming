import { writeFileSync } from 'node:fs';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerAppPref } from '../src/cli/appPrefCommand.js';
import type { StoreLayout } from '../src/domain/types.js';
import type * as Safety from '../src/engine/safety.js';
import {
  appPrefWriteNotices,
  registerAppPrefAllowlist,
  registerAppPrefWriteNotice,
  type AppPrefWriteNotice,
} from '../src/store/appPrefs.js';
import { makeStore } from './helpers/store.js';

/**
 * Write notices: a line a plugin prints after a preference was written. The
 * natural use is a guarded preference an allowlist let through, which is where
 * saying what the write means matters; the core prints none.
 */

// The app is always closed here: nothing in this file may reach a real one.
vi.mock('../src/engine/safety.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Safety>();
  return { ...actual, inspectApp: () => ({ running: false, evidence: [] }) };
});

const GUARDED = 'coworkHipaaRestricted';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function storeWith(preferences: Record<string, unknown>): StoreLayout {
  const store = makeStore();
  writeFileSync(store.desktopConfigFile, JSON.stringify({ preferences }), 'utf8');
  return store;
}

async function run(store: StoreLayout, args: string[]): Promise<string> {
  const app = new Command();
  app.exitOverride();
  registerAppPref(app, () => ({ store }));
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  try {
    await app.parseAsync(args, { from: 'user' });
  } finally {
    spy.mockRestore();
  }
  return lines.join('\n');
}

/** Speaks only about a guarded write. */
const guardedOnly: AppPrefWriteNotice = (write, { guarded }) =>
  guarded ? `NOTICE: ${write.name} was changed outside the app` : undefined;

describe('app pref write notices', () => {
  it('print after a guarded write an allowlist let through', async () => {
    const store = storeWith({ [GUARDED]: true });
    cleanups.push(registerAppPrefAllowlist({ name: 'example', keys: [GUARDED] }));
    cleanups.push(registerAppPrefWriteNotice(guardedOnly));

    const output = await run(store, ['pref', GUARDED, 'false', '--yes']);
    expect(output).toContain(`NOTICE: ${GUARDED} was changed outside the app`);
  });

  it('say nothing for an ordinary preference', async () => {
    const store = storeWith({ menuBarEnabled: true });
    cleanups.push(registerAppPrefWriteNotice(guardedOnly));

    const output = await run(store, ['pref', 'menuBarEnabled', 'false', '--yes']);
    expect(output).not.toContain('NOTICE');
  });

  it('reach the JSON output too', async () => {
    const store = storeWith({ [GUARDED]: true });
    cleanups.push(registerAppPrefAllowlist({ name: 'example', keys: [GUARDED] }));
    cleanups.push(registerAppPrefWriteNotice(guardedOnly));

    const output = await run(store, ['pref', GUARDED, 'false', '--yes', '--json']);
    const parsed = JSON.parse(output) as { written: { notices?: string[] }[] };
    expect(parsed.written[0]?.notices).toEqual([`NOTICE: ${GUARDED} was changed outside the app`]);
  });

  it('are not asked on a dry run', async () => {
    const store = storeWith({ [GUARDED]: true });
    cleanups.push(registerAppPrefAllowlist({ name: 'example', keys: [GUARDED] }));
    const notice = vi.fn(guardedOnly);
    cleanups.push(registerAppPrefWriteNotice(notice));

    await run(store, ['pref', GUARDED, 'false']);
    expect(notice).not.toHaveBeenCalled();
  });

  it('a notice that throws becomes a line of its own', () => {
    cleanups.push(
      registerAppPrefWriteNotice(() => {
        throw new Error('notice broke');
      }),
    );
    const lines = appPrefWriteNotices(
      { name: 'menuBarEnabled', from: true, to: false, unset: false },
      { store: makeStore(), guarded: false },
    );
    expect(lines).toEqual(['a write notice failed: notice broke']);
  });

  it('with none registered, nothing is added', async () => {
    const store = storeWith({ menuBarEnabled: true });
    const output = await run(store, ['pref', 'menuBarEnabled', 'false', '--yes', '--json']);
    const parsed = JSON.parse(output) as { written: Record<string, unknown>[] };
    expect(parsed.written[0]).not.toHaveProperty('notices');
  });
});
