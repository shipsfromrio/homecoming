import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Safety from '../src/engine/safety.js';
import { Ledger } from '../src/ledger/log.js';
import type { StoreLayout } from '../src/domain/types.js';
import {
  registerSweepPhase,
  sweepPhaseInteractiveOptions,
  type Unregister,
} from '../src/extensions.js';
import { ScriptedUi } from './helpers/scripted.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

vi.mock('../src/engine/safety.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Safety>();
  return {
    ...actual,
    inspectApp: () => ({ running: false, evidence: [] }),
    assertRemovable: () => {},
  };
});

vi.mock('../src/engine/desktop.js', () => ({
  inspectDesktop: () => ({ running: false, codeSessions: 0, selfHosted: false }),
  inspectDesktopFor: () => ({ running: false, codeSessions: 0, selfHosted: false }),
  quitDesktop: () => Promise.resolve({ outcome: 'not-running' }),
  startDesktop: () => Promise.resolve(true),
  packagedAppId: () => undefined,
  runningStores: () => [],
  readProcesses: () => [],
  hostedByDesktop: () => false,
  DesktopControlError: class extends Error {},
}));

const { runInteractive } = await import('../src/cli/interactive.js');

let undo: Unregister[] = [];
let store: StoreLayout;
let ledger: Ledger;

beforeEach(() => {
  store = makeStore();
  ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'hc-opts-')), 'l.jsonl'));
  writeSession(store, NEW_ACCOUNT, session({ sessionId: '11111111-1111-4111-8111-11111111aaaa' }));
  writeFileSync(
    store.configFile,
    JSON.stringify({ lastKnownAccountUuid: NEW_ACCOUNT.accountUuid }),
    'utf8',
  );
  writeSession(store, OLD_ACCOUNT, session({ sessionId: '00000000-0000-4000-8000-0000000000a1' }));
});

afterEach(() => {
  for (const step of undo.reverse()) step();
  undo = [];
});

function recorder(name: string, seen: Array<{ dryRun: boolean; options: unknown }>): Unregister {
  return registerSweepPhase({
    name,
    run: ({ dryRun, options }) => {
      seen.push({ dryRun, options });
      return undefined;
    },
  });
}

describe('options a sweep phase declares for the menu', () => {
  it('reach every phase on the dry run and on the real run', async () => {
    const seen: Array<{ dryRun: boolean; options: unknown }> = [];
    undo.push(
      registerSweepPhase({
        name: 'declares',
        interactiveOptions: { depth: 2 },
        run: () => undefined,
      }),
      registerSweepPhase({
        name: 'computes',
        interactiveOptions: ({ target }) => ({ who: target.accountUuid, depth: 3 }),
        run: () => undefined,
      }),
      recorder('reader', seen),
    );
    const ui = new ScriptedUi(['sweep', 'go', 'later', 'quit']);
    await runInteractive(store, ledger, ui);
    const expected = { depth: 3, who: NEW_ACCOUNT.accountUuid };
    expect(seen).toEqual([
      { dryRun: true, options: expected },
      { dryRun: false, options: expected },
    ]);
  });

  it('are {} when no phase declares any, as before', async () => {
    const seen: Array<{ dryRun: boolean; options: unknown }> = [];
    undo.push(recorder('reader', seen));
    const ui = new ScriptedUi(['sweep', 'go', 'later', 'quit']);
    await runInteractive(store, ledger, ui);
    expect(seen).toEqual([
      { dryRun: true, options: {} },
      { dryRun: false, options: {} },
    ]);
  });

  it('skip a declaration that throws and keep the others', () => {
    undo.push(
      registerSweepPhase({
        name: 'broken',
        interactiveOptions: () => {
          throw new Error('no');
        },
        run: () => undefined,
      }),
      registerSweepPhase({
        name: 'fine',
        interactiveOptions: { keep: true },
        run: () => undefined,
      }),
    );
    expect(sweepPhaseInteractiveOptions({ store, ledger, target: NEW_ACCOUNT })).toEqual({
      keep: true,
    });
  });
});
