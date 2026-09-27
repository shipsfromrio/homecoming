import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Safety from '../src/engine/safety.js';
import { Ledger } from '../src/ledger/log.js';
import { listActive, project } from '../src/ledger/project.js';
import { accountDir } from '../src/domain/paths.js';
import { scanAccount } from '../src/store/scanner.js';
import type { StoreLayout } from '../src/domain/types.js';
import { CANCEL } from '../src/tui/ui.js';
import { usePlugin } from '../src/plugin.js';
import { ScriptedUi } from './helpers/scripted.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

/** Scripted answers, consumed in order by the Ui double. */
let answers: unknown[] = [];
let ui: ScriptedUi;

async function play(): Promise<void> {
  ui = new ScriptedUi(answers);
  await runInteractive(store, ledger, ui);
}

// The real probe reports whatever Claude Desktop is doing on the machine running
// the tests, which has nothing to do with the flow under test. Both entry points
// are replaced: assertRemovable calls the module's own lockfile check internally,
// so overriding only the export would leave the engine's gate live.
vi.mock('../src/engine/safety.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Safety>();
  return {
    ...actual,
    inspectApp: () => ({ running: false, evidence: [] }),
    assertRemovable: () => {},
  };
});

// Nothing in a test may close or launch the real Claude Desktop. Stubbed rather
// than trusted: a scripted answer that drifted by one step could otherwise pick
// "Restart it" and take down the machine's running app mid-suite.
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

let store: StoreLayout;
let ledger: Ledger;

beforeEach(() => {
  store = makeStore();
  ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-int-')), 'l.jsonl'));
  // The current account must exist as a directory to be resolvable as a target.
  writeSession(store, NEW_ACCOUNT, session({ sessionId: '11111111-1111-4111-8111-11111111aaaa' }));
  writeFileSync(
    store.configFile,
    JSON.stringify({ lastKnownAccountUuid: NEW_ACCOUNT.accountUuid }),
    'utf8',
  );
  writeSession(
    store,
    OLD_ACCOUNT,
    session({ sessionId: '00000000-0000-4000-8000-0000000000a1', title: 'Refactor parser' }),
  );
  writeSession(
    store,
    OLD_ACCOUNT,
    session({ sessionId: '00000000-0000-4000-8000-0000000000a2', title: 'Fix the build' }),
  );
});

describe('the guided menu', () => {
  it('fosters a whole account and returns to the menu afterwards', async () => {
    answers = [
      'foster', // menu
      ['0'], // source: the old account's only organization
      'all', // take every session
      'go', // confirm
      'later', // decline the offer to restart the app

      'quit', // back at the menu
    ];

    await play();

    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(2);
    expect(listActive(project(ledger.read()))).toHaveLength(2);
    expect(answers).toHaveLength(0);
  });

  it('sweeps everything, archived included, from one answer', async () => {
    // The row exists because "bring everything" used to mean three screens plus a
    // flag nobody knew about: without --archived this session stays behind.
    writeSession(
      store,
      OLD_ACCOUNT,
      session({
        sessionId: '00000000-0000-4000-8000-0000000000a3',
        title: 'Tucked away',
        isArchived: true,
      }),
    );

    answers = [
      'sweep', // menu
      'go', // confirm
      'later', // decline the offer to restart the app
      'quit',
    ];

    await play();

    const copies = scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy);
    expect(copies).toHaveLength(3);
    const tucked = copies.find((s) => s.data.title?.includes('Tucked away'));
    // It arrives in the archived view rather than quietly reappearing in Recents.
    expect(tucked?.data.isArchived).toBe(true);
    expect(answers).toHaveLength(0);
  });

  it("runs a plugin's sweep phases, as `homecoming sweep` does: on the plan and after the writes", async () => {
    const calls: boolean[] = [];
    const undo = usePlugin({
      name: 'menu-phase',
      sweepPhases: [
        {
          name: 'menu-phase',
          run: ({ dryRun }) => {
            calls.push(dryRun);
            return { lines: [`menu phase ran, dry run: ${dryRun}`] };
          },
        },
      ],
    });
    try {
      answers = ['sweep', 'go', 'later', 'quit'];
      await play();
    } finally {
      undo();
    }

    expect(calls).toEqual([true, false]);
    expect(ui.notes.some((note) => note.message.includes('menu phase ran, dry run: true'))).toBe(
      true,
    );
    expect(ui.messages).toContain('menu phase ran, dry run: false');
    expect(answers).toHaveLength(0);
  });

  it('says "Nothing to sweep" when a plugin phase only reports, and offers no restart for it', async () => {
    // A phase that always prints something, even "nothing to do", used to count
    // as pending work (and as a change after the writes): the menu then never
    // said "Nothing to sweep" and offered a restart on every run. Only the
    // phase's own `pending` / `changed` count now.
    const undo = usePlugin({
      name: 'chatty',
      sweepPhases: [{ name: 'chatty', run: () => ({ lines: ['chatty: nothing to do'] }) }],
    });
    try {
      answers = [
        'sweep', // first sweep brings the two sessions
        'go',
        'later', // the core wrote copies, so the restart is offered
        'sweep', // second sweep: nothing left for the core, and the phase only talks
        'quit',
      ];
      await play();
    } finally {
      undo();
    }

    expect(
      ui.info.filter((line) => line.startsWith('Nothing to sweep')),
      'the second sweep must say there is nothing to sweep',
    ).toHaveLength(1);
    // One confirmation and one restart offer, both from the first sweep only.
    expect(ui.selects.filter((s) => s.message.startsWith('Bring all of it'))).toHaveLength(1);
    expect(answers).toHaveLength(0);
  });

  it('shows the plan and offers the restart when a plugin phase declares pending work and a change', async () => {
    const undo = usePlugin({
      name: 'worker',
      sweepPhases: [
        {
          name: 'worker',
          run: ({ dryRun }) =>
            dryRun
              ? { lines: ['worker: 1 thing to write'], pending: 1 }
              : { lines: ['worker: wrote 1 thing'], changed: 1 },
        },
      ],
    });
    try {
      answers = [
        'sweep', // first sweep: core work plus the phase
        'go',
        'later',
        'sweep', // second sweep: the core has nothing, the phase still declares work
        'go', // so the plan is shown and confirmed
        'later', // and its declared change alone earns the restart offer
        'quit',
      ];
      await play();
    } finally {
      undo();
    }

    expect(ui.info.some((line) => line.startsWith('Nothing to sweep'))).toBe(false);
    expect(ui.selects.filter((s) => s.message.startsWith('Bring all of it'))).toHaveLength(2);
    expect(ui.messages.filter((m) => m === 'worker: wrote 1 thing')).toHaveLength(2);
    expect(answers).toHaveLength(0);
  });

  it('narrows the batch by title before writing', async () => {
    answers = ['foster', ['0'], 'title', 'refactor', 'go', 'later', 'quit'];

    await play();

    const copies = scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy);
    expect(copies).toHaveLength(1);
    expect(copies[0]!.data.title).toContain('Refactor parser');
  });

  it('writes nothing when the confirmation is declined, and keeps the menu open', async () => {
    answers = [
      'foster',
      ['0'],
      'all',
      'cancel', // decline
      'status', // menu is still running
      'quit',
    ];

    await play();

    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(0);
    expect(answers).toHaveLength(0);
  });

  it('backing out of the source picker returns to the menu instead of exiting', async () => {
    // Ticking nothing is how you leave a multiselect: there is no Back row to press.
    answers = ['foster', [], 'quit'];

    await play();

    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(0);
    expect(answers).toHaveLength(0);
  });

  it('returns fostered copies, leaving the origin untouched', async () => {
    answers = ['foster', ['0'], 'all', 'go', 'later', 'return', 'all', true, 'later', 'quit'];

    await play();

    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(0);
    expect(listActive(project(ledger.read()))).toHaveLength(0);
    expect(scanAccount(store, OLD_ACCOUNT)).toHaveLength(2);
    // Asserted explicitly: an empty active list is also what a run that never
    // fostered anything would produce, so it proves nothing on its own.
    expect(ledger.read().filter((event) => event.kind === 'returned')).toHaveLength(2);
  });

  it('treats Ctrl+C at the menu as quit', async () => {
    answers = [CANCEL];

    await expect(play()).resolves.toBeUndefined();
  });
});

/**
 * An account can hold more than one organization, and the sidebar only ever reads
 * one of them. Taking the whole account and taking a single organization are both
 * legitimate, and sessions filed under a second organization of the *current*
 * account are just as invisible as another account's.
 */
describe('organizations within an account', () => {
  const OTHER_ORG = {
    accountUuid: OLD_ACCOUNT.accountUuid,
    organizationUuid: '00000000-0000-4000-8000-00000000000f',
  };
  const SIBLING_ORG = {
    accountUuid: NEW_ACCOUNT.accountUuid,
    organizationUuid: '11111111-1111-4111-8111-11111111000f',
  };

  it('fosters a single organization without dragging in the rest of the account', async () => {
    writeSession(
      store,
      OTHER_ORG,
      session({ sessionId: '00000000-0000-4000-8000-0000000000b1', title: 'Second org work' }),
    );

    // 0 = the whole account, 1 = its first organization, 2 = its second.
    answers = ['foster', ['2'], 'all', 'go', 'later', 'quit'];
    await play();

    const copies = scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy);
    expect(copies).toHaveLength(1);
    expect(copies[0]!.data.title).toContain('Second org work');
  });

  it('offers a shortcut that takes every organization of the account', async () => {
    writeSession(
      store,
      OTHER_ORG,
      session({ sessionId: '00000000-0000-4000-8000-0000000000b2', title: 'Second org work' }),
    );

    answers = ['foster', ['0'], 'all', 'go', 'later', 'quit'];
    await play();

    // Two from the first organization plus one from the second.
    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(3);
  });

  it('can foster from another organization of the account already signed in', async () => {
    writeSession(
      store,
      SIBLING_ORG,
      session({ sessionId: '11111111-1111-4111-8111-1111111100b3', title: 'Sibling org work' }),
    );
    // Which organization the sidebar reads is inferred from how recently the app
    // touched its directory, so the target has to be the newer one here — as it
    // would be in practice, since that is the one being written to.
    const target = accountDir(store, NEW_ACCOUNT);
    const later = new Date(Date.now() + 60_000);
    utimesSync(target, later, later);

    // 0 = every account at once, 1 = the old account's organization, 2 = this
    // account's other organization. Both accounts contribute one eligible
    // organization, so neither gets the whole-account shortcut. The sibling must
    // be offered at all: excluding the entire current account would make that
    // session permanently unreachable.
    answers = ['foster', ['2'], 'all', 'go', 'later', 'quit'];
    await play();

    const copies = scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy);
    expect(copies).toHaveLength(1);
    expect(copies[0]!.data.title).toContain('Sibling org work');
  });

  it('never offers the directory the sidebar already reads', async () => {
    // Only the old account's single organization is a valid source here, so any
    // index beyond the first would mean the target itself was on the list.
    answers = ['foster', ['1'], 'all', 'go', 'later', 'quit'];
    await play();

    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(0);
  });
});

/**
 * The scan below this screen always took a list of directories, so being able to
 * name only one of them was a limit of the picker alone: consolidating three
 * accounts meant three passes through the whole flow.
 */
describe('taking more than one source at once', () => {
  const THIRD_ACCOUNT = {
    accountUuid: '22222222-2222-4222-8222-222222222221',
    organizationUuid: '22222222-2222-4222-8222-222222222222',
  };

  it('sweeps every account in one pass', async () => {
    writeSession(
      store,
      THIRD_ACCOUNT,
      session({ sessionId: '22222222-2222-4222-8222-2222222200c1', title: 'Third account work' }),
    );

    // 0 = the row that stands for both accounts.
    answers = ['foster', ['0'], 'all', 'go', 'later', 'quit'];
    await play();

    const copies = scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy);
    expect(copies).toHaveLength(3);
    expect(copies.map((c) => c.data.title)).toContainEqual(
      expect.stringContaining('Third account work'),
    );
  });

  it('counts a directory once when the account and its organization are both ticked', async () => {
    writeSession(
      store,
      {
        accountUuid: OLD_ACCOUNT.accountUuid,
        organizationUuid: '00000000-0000-4000-8000-00000000000f',
      },
      session({ sessionId: '00000000-0000-4000-8000-0000000000c2', title: 'Second org work' }),
    );

    // 0 = the whole account, 1 = its first organization: overlapping, not
    // contradictory, and the overlap must not produce a second copy.
    answers = ['foster', ['0', '1'], 'all', 'go', 'later', 'quit'];
    await play();

    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(3);
  });

  it('refuses to read this installation and another one in the same pass', async () => {
    answers = ['foster', ['0', '__other_store'], 'quit'];
    await play();

    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(0);
    expect(ui.errors.join('\n')).toMatch(/one installation at a time/i);
    expect(answers).toHaveLength(0);
  });
});

describe('backing out of any step', () => {
  /**
   * The "Back" entry carries a string, while callers checked for a symbol. The
   * filter step checked only the symbol, so the literal fell through and was used
   * as a lookup key — the menu crashed with "Cannot read properties of undefined".
   */
  it('returns to the menu from the filter step instead of crashing', async () => {
    answers = ['foster', ['0'], '__back', 'quit'];

    await expect(play()).resolves.toBeUndefined();

    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(0);
    expect(answers).toHaveLength(0);
  });

  it('returns to the menu from the destination step', async () => {
    // A second destination has to exist for the step to be asked at all.
    writeSession(
      store,
      {
        accountUuid: NEW_ACCOUNT.accountUuid,
        organizationUuid: '11111111-1111-4111-8111-1111111100dd',
      },
      session({ sessionId: '11111111-1111-4111-8111-1111111100de' }),
    );
    const active = accountDir(store, NEW_ACCOUNT);
    const later = new Date(Date.now() + 60_000);
    utimesSync(active, later, later);

    answers = ['foster', ['0'], '__back', 'quit'];

    await expect(play()).resolves.toBeUndefined();
    expect(answers).toHaveLength(0);
  });
});

describe('choosing where the copies go', () => {
  const ELSEWHERE = {
    accountUuid: OLD_ACCOUNT.accountUuid,
    organizationUuid: '00000000-0000-4000-8000-0000000000e1',
  };

  it('can write into an organization other than the one in use', async () => {
    // ELSEWHERE is a second organization of the old account: available as a
    // destination precisely because it is not the source and not the target.
    writeSession(store, ELSEWHERE, session({ sessionId: '00000000-0000-4000-8000-0000000000e2' }));

    // Source = the old account's first organization (index 1, after the
    // whole-account shortcut at 0). The destination picker is keyed by
    // account/organization rather than by position, so it is named outright.
    const destination = `${ELSEWHERE.accountUuid}/${ELSEWHERE.organizationUuid}`;
    answers = ['foster', ['1'], 'all', 'elsewhere', destination, 'go', 'quit'];
    await play();

    // Nothing landed where the sidebar reads; it all went to the chosen place.
    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(0);
    expect(scanAccount(store, ELSEWHERE).filter((s) => s.isCopy)).toHaveLength(2);
  });

  it('does not ask when the current directory is the only destination', async () => {
    // Only the old account's organization is a source, and nothing else exists,
    // so the flow must not consume an answer for a question with one option.
    answers = ['foster', ['0'], 'all', 'go', 'later', 'quit'];
    await play();

    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(2);
    expect(answers).toHaveLength(0);
  });
});

describe('picking sessions individually', () => {
  it('takes only the ticked ones', async () => {
    // Sessions are offered most recently used first, so index 0 is deterministic.
    answers = ['foster', ['0'], 'pick', ['0'], 'go', 'later', 'quit'];
    await play();

    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(1);
    expect(answers).toHaveLength(0);
  });

  it('treats ticking nothing as a change of mind rather than a batch of zero', async () => {
    answers = ['foster', ['0'], 'pick', [], 'quit'];
    await play();

    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(0);
    expect(answers).toHaveLength(0);
  });
});

describe('the confirmation screen', () => {
  it('changes the prefix without leaving it', async () => {
    answers = ['foster', ['0'], 'all', 'prefix', '[old] ', 'go', 'later', 'quit'];
    await play();

    const copies = scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy);
    expect(copies).toHaveLength(2);
    for (const copy of copies) expect(copy.data.title).toMatch(/^\[old] /);
  });

  it('writes nothing when the answer is one it does not understand', async () => {
    // A prompt that returns something unexpected used to spin the loop forever.
    answers = ['foster', ['0'], 'all', 'something-else', 'quit'];

    await expect(play()).resolves.toBeUndefined();
    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(0);
  });
});

describe('naming an account', () => {
  it('records the label and uses it afterwards', async () => {
    answers = ['label', OLD_ACCOUNT.accountUuid, 'the old one', 'quit'];
    await play();

    expect(project(ledger.read()).labels.get(OLD_ACCOUNT.accountUuid)).toBe('the old one');
  });

  it('keeps the old name when the answer is blank', async () => {
    answers = ['label', OLD_ACCOUNT.accountUuid, '   ', 'quit'];
    await play();

    expect(project(ledger.read()).labels.has(OLD_ACCOUNT.accountUuid)).toBe(false);
  });

  it('does not turn an empty submission into the word "undefined"', async () => {
    // clack resolves an empty text prompt as undefined rather than '', which a
    // String() once coerced into a name that passed every emptiness check.
    answers = ['label', OLD_ACCOUNT.accountUuid, undefined, 'quit'];
    await play();

    expect(project(ledger.read()).labels.has(OLD_ACCOUNT.accountUuid)).toBe(false);
  });
});

describe('the main menu', () => {
  it('leaves rather than looping when the answer is unrecognised', async () => {
    // Exhausting the scripted answers yields undefined, which matches no case.
    answers = ['not-a-menu-entry'];

    await expect(play()).resolves.toBeUndefined();
  });
});

describe('bringing sessions from another installation', () => {
  /**
   * A second profile is a whole separate store. Nothing in the store homecoming
   * resolved points at it, so the menu has to offer it explicitly — and the copy
   * has to record which store it came from.
   */
  it('fosters across stores and records the origin', async () => {
    const other = makeStore();
    writeFileSync(
      other.configFile,
      JSON.stringify({ lastKnownAccountUuid: OLD_ACCOUNT.accountUuid }),
      'utf8',
    );
    writeSession(
      other,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000d1', title: 'In the other profile' }),
    );

    answers = [
      'foster',
      ['__other_store'], // "Another installation or profile…"
      '__type_a_path', // not running, so type where it lives
      other.root,
      ['0'], // its only account/organization
      'all',
      'go',
      'later',
      'quit',
    ];
    await play();

    const copies = scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy);
    expect(copies).toHaveLength(1);
    expect(copies[0]!.data.title).toContain('In the other profile');
    expect(copies[0]!.data._foster!.originStore).toBe(other.root);
    // The other store is left exactly as it was.
    expect(scanAccount(other, OLD_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(0);
  });

  it('comes back to the menu when the path is not a store', async () => {
    answers = [
      'foster',
      ['__other_store'],
      '__type_a_path',
      mkdtempSync(path.join(tmpdir(), 'not-a-store-')),
      'quit',
    ];

    await expect(play()).resolves.toBeUndefined();
    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(0);
    expect(answers).toHaveLength(0);
  });
});
