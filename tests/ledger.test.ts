import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { comparablePath } from '../src/domain/paths.js';
import { Ledger } from '../src/ledger/log.js';
import { isFostered, listActive, project, selectByTarget } from '../src/ledger/project.js';
import type { ActiveFostering, LedgerEvent } from '../src/ledger/types.js';
import type { AccountRef } from '../src/domain/types.js';
import { NEW_ACCOUNT, OLD_ACCOUNT } from './helpers/store.js';

function makeLedger(): Ledger {
  return new Ledger(
    path.join(mkdtempSync(path.join(tmpdir(), 'homecoming-ledger-')), 'ledger.jsonl'),
  );
}

const fostered = {
  kind: 'fostered' as const,
  originSessionId: 'local_origin-1',
  origin: OLD_ACCOUNT,
  target: NEW_ACCOUNT,
  copySessionId: 'local_copy-1',
  copyPath: '/store/new/local_copy-1.json',
  originalTitle: 'Refactor parser',
  prefix: '↪ ',
};

describe('Ledger', () => {
  it('round-trips appended events', () => {
    const ledger = makeLedger();
    ledger.append(fostered);

    const events = ledger.read();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'fostered', v: 1, originSessionId: 'local_origin-1' });
  });

  it('returns empty for a ledger that does not exist yet', () => {
    expect(makeLedger().read()).toEqual([]);
  });

  it('throws, naming the path, when the ledger path is a directory rather than missing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'homecoming-ledger-'));
    const asDir = path.join(dir, 'ledger.jsonl');
    mkdirSync(asDir);
    const ledger = new Ledger(asDir);

    expect(() => ledger.read()).toThrow(asDir);
  });

  it('round-trips the optional template field on a fostered event, old entries folding without it', () => {
    const ledger = makeLedger();
    ledger.append({
      ...fostered,
      prefix: '(stale, stopped 01/09 18:10) ',
      template: '(stale, stopped {when}) ',
    });
    ledger.append({
      ...fostered,
      originSessionId: 'local_origin-2',
      copySessionId: 'local_copy-2',
    });

    const events = ledger.read();
    expect(events[0]).toMatchObject({ template: '(stale, stopped {when}) ' });
    expect((events[1] as { template?: string }).template).toBeUndefined();
  });

  it('keeps a kind it does not fold as a record, out of read() and out of the fold', () => {
    // The ledger is shared with other builds. A line of a kind this one does
    // not know is somebody's state: dropping it would be harmless only as long
    // as nothing ever rewrote the file, so it is carried instead.
    const ledger = makeLedger();
    ledger.append(fostered);
    appendFileSync(
      ledger.path,
      `${JSON.stringify({ v: 1, ts: 1, kind: 'other.thing_happened', payload: { n: 1 } })}\n`,
      'utf8',
    );

    expect(ledger.read().map((event) => event.kind)).toEqual(['fostered']);
    const records = ledger.readRecords();
    expect(records.map((record) => record.kind)).toEqual(['fostered', 'other.thing_happened']);
    expect(records[1]).toMatchObject({ payload: { n: 1 } });
    expect(project(records as LedgerEvent[]).active.size).toBe(1);
  });

  it('appends a record of a foreign kind and refuses a core kind through that door', () => {
    const ledger = makeLedger();
    ledger.appendRecord({ kind: 'other.noted', value: 'x' });
    expect(ledger.readRecords()).toEqual([
      expect.objectContaining({ kind: 'other.noted', value: 'x' }),
    ]);
    expect(ledger.read()).toEqual([]);
    expect(() => ledger.appendRecord({ kind: 'fostered' })).toThrow(/core event kind/);
  });

  it('survives a torn final line instead of losing the whole log', () => {
    const ledger = makeLedger();
    ledger.append(fostered);
    appendFileSync(ledger.path, '{"kind":"fostered","v":1', 'utf8');

    expect(ledger.read()).toHaveLength(1);
  });

  it('skips a well-formed JSON line that is not an event, and keeps the neighbor', () => {
    const ledger = makeLedger();
    ledger.append(fostered);
    appendFileSync(ledger.path, `${JSON.stringify({ title: 'no kind' })}\n`, 'utf8');
    ledger.append({
      ...fostered,
      originSessionId: 'local_origin-2',
      copySessionId: 'local_copy-2',
    });

    const events = ledger.read();
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.kind)).toEqual(['fostered', 'fostered']);
  });

  describe('caching', () => {
    it('rereads on the first call and reuses the cache while the file is unchanged', () => {
      const ledger = makeLedger();
      ledger.append(fostered);

      const first = ledger.read();
      // Same array reference, not merely an equal one — the identity is what
      // lets project() (ledger/project.ts) memoize its own fold over it.
      expect(ledger.read()).toBe(first);
    });

    it('rereads once the file changes underneath it', () => {
      const ledger = makeLedger();
      ledger.append(fostered);
      const first = ledger.read();

      // Written directly, bypassing this instance's own append — the way a
      // second `homecoming` process, or a hand edit, would change the file.
      appendFileSync(
        ledger.path,
        `${JSON.stringify({
          ...fostered,
          v: 1,
          ts: 2,
          toolVersion: '0.1.0',
          originSessionId: 'local_origin-2',
          copySessionId: 'local_copy-2',
        })}\n`,
        'utf8',
      );

      const second = ledger.read();
      expect(second).not.toBe(first);
      expect(second).toHaveLength(2);
    });

    it('grows the cached array in place on append, instead of dropping it', () => {
      const ledger = makeLedger();
      ledger.append(fostered);
      const first = ledger.read();

      ledger.append({
        ...fostered,
        originSessionId: 'local_origin-2',
        copySessionId: 'local_copy-2',
      });

      const second = ledger.read();
      expect(second).toBe(first);
      expect(second).toHaveLength(2);
    });

    it('fixes a missing trailing newline before its first append, so a torn line does not glue to the next event', () => {
      const ledger = makeLedger();
      // A ledger left without a trailing newline — the shape a killed process or
      // power loss leaves, whether or not the last line's JSON is itself intact.
      // Written directly: this is damage from outside this instance, not
      // something its own append ever produces on its own.
      writeFileSync(
        ledger.path,
        JSON.stringify({ ...fostered, v: 1, ts: 1, toolVersion: '0.1.0' }),
        'utf8',
      );

      ledger.append({
        ...fostered,
        originSessionId: 'local_origin-2',
        copySessionId: 'local_copy-2',
      });

      const events = ledger.read();
      expect(events).toHaveLength(2);
      expect(
        events.map((event) => (event as { originSessionId?: string }).originSessionId),
      ).toEqual(['local_origin-1', 'local_origin-2']);
    });

    it('does not touch a file that already ends in a newline', () => {
      const ledger = makeLedger();
      ledger.append(fostered);
      const before = ledger.read();
      expect(before).toHaveLength(1);

      ledger.append({
        ...fostered,
        originSessionId: 'local_origin-2',
        copySessionId: 'local_copy-2',
      });

      const after = ledger.read();
      expect(after).toHaveLength(2);
      expect(after[0]).toMatchObject({ originSessionId: 'local_origin-1' });
    });

    it("does not lose a concurrent writer's event when this instance appends without re-reading first", () => {
      // Two `Ledger` instances over the same file, the way two `homecoming`
      // processes (or a long-lived sweep instance and a detached restart
      // helper) would share one ledger.
      const ledgerA = makeLedger();
      const ledgerB = new Ledger(ledgerA.path);

      ledgerA.append(fostered);
      ledgerA.read(); // primes ledgerA's cache at 1 event.

      // ledgerB appends directly to the file, bypassing ledgerA entirely —
      // ledgerA's cache is now stale, but nothing has told it so yet.
      ledgerB.append({
        ...fostered,
        originSessionId: 'local_origin-2',
        copySessionId: 'local_copy-2',
      });

      // ledgerA appends without an intervening read(). Its cache-growth path
      // must notice the file moved under it instead of blindly pushing onto
      // a 1-event array and mistaking the result for the truth.
      ledgerA.append({
        ...fostered,
        originSessionId: 'local_origin-3',
        copySessionId: 'local_copy-3',
      });

      expect(
        ledgerA.read().map((event) => (event as { originSessionId?: string }).originSessionId),
      ).toEqual(['local_origin-1', 'local_origin-2', 'local_origin-3']);

      // A fresh instance over the same file must agree — this is not a quirk
      // of ledgerA recovering, it is the actual content of the file.
      expect(
        new Ledger(ledgerA.path)
          .read()
          .map((event) => (event as { originSessionId?: string }).originSessionId),
      ).toEqual(['local_origin-1', 'local_origin-2', 'local_origin-3']);
    });
  });
});

describe('projection', () => {
  it('folds a fostering into active state', () => {
    const state = project([{ ...fostered, v: 1, ts: 10, toolVersion: '0.1.0' }]);

    expect(listActive(state)).toHaveLength(1);
    expect(isFostered(state, 'local_origin-1', NEW_ACCOUNT)).toBe(true);
  });

  /**
   * `project()` memoizes its fold over a given events array (identity + length)
   * so a sweep's many `project(ledger.read())` calls over an unchanged ledger
   * redo the fold once. `fosterSessions` (engine/executor.ts) mutates the state
   * it gets back — deleting a reconciled fostering — to keep a single run's own
   * view current as it goes. Memoizing without defending against that would
   * leak one call's mutation into the next call's state whenever two calls
   * share a cache entry (no ledger write in between), which is exactly the
   * dry-run-batch shape that caller runs in.
   */
  it('does not leak a mutation of the returned state into a later call over the same events', () => {
    const events: LedgerEvent[] = [{ ...fostered, v: 1, ts: 10, toolVersion: '0.1.0' }];

    const first = project(events);
    expect(listActive(first)).toHaveLength(1);
    first.active.clear();
    expect(listActive(first)).toHaveLength(0);

    // A second call over the identical array — the shape `Ledger.read()`
    // produces when nothing has appended in between — must not see the clear
    // above: each caller gets its own Maps to do with as it pleases.
    const second = project(events);
    expect(listActive(second)).toHaveLength(1);
  });

  it('still reflects a growing array after the cached fold is invalidated by length', () => {
    const events: LedgerEvent[] = [{ ...fostered, v: 1, ts: 10, toolVersion: '0.1.0' }];
    expect(listActive(project(events))).toHaveLength(1);

    events.push({
      ...fostered,
      v: 1,
      ts: 20,
      toolVersion: '0.1.0',
      originSessionId: 'local_origin-2',
      copySessionId: 'local_copy-2',
    });
    expect(listActive(project(events))).toHaveLength(2);
  });

  it('removes it again on return', () => {
    const state = project([
      { ...fostered, v: 1, ts: 10, toolVersion: '0.1.0' },
      {
        kind: 'returned',
        v: 1,
        ts: 20,
        toolVersion: '0.1.0',
        originSessionId: 'local_origin-1',
        target: NEW_ACCOUNT,
        copySessionId: 'local_copy-1',
      },
    ]);

    expect(listActive(state)).toHaveLength(0);
    expect(isFostered(state, 'local_origin-1', NEW_ACCOUNT)).toBe(false);
  });

  it(
    'keeps both copies active when a second fostered event shares a key — the ' +
      'second-file path',
    () => {
      // `resolveExisting` (engine/executor.ts) legitimately writes a second
      // `fostered` event under the very key the first one used, when the first
      // copy is still on disk but the offered card's own file reaches records it
      // cannot (a second file of one conversation). Both copies are current, so
      // folding this must keep both — keying `active` on the fostering key
      // instead of on the copy id used to let the second event overwrite the
      // first, silently orphaning it: measured against the real ledger, 275
      // `fostered` events did this.
      const state = project([
        { ...fostered, v: 1, ts: 10, toolVersion: '0.1.0' },
        { ...fostered, v: 1, ts: 20, toolVersion: '0.1.0', copySessionId: 'local_copy-2' },
      ]);

      expect(listActive(state)).toHaveLength(2);
      expect(
        listActive(state)
          .map((f) => f.copySessionId)
          .sort(),
      ).toEqual(['local_copy-1', 'local_copy-2']);
      expect(isFostered(state, 'local_origin-1', NEW_ACCOUNT)).toBe(true);
    },
  );

  it('returns both copies filed under one key — neither hides the other', () => {
    const state = project([
      { ...fostered, v: 1, ts: 10, toolVersion: '0.1.0' },
      { ...fostered, v: 1, ts: 20, toolVersion: '0.1.0', copySessionId: 'local_copy-2' },
      {
        kind: 'returned',
        v: 1,
        ts: 30,
        toolVersion: '0.1.0',
        originSessionId: 'local_origin-1',
        target: NEW_ACCOUNT,
        copySessionId: 'local_copy-1',
      },
      {
        kind: 'returned',
        v: 1,
        ts: 40,
        toolVersion: '0.1.0',
        originSessionId: 'local_origin-1',
        target: NEW_ACCOUNT,
        copySessionId: 'local_copy-2',
      },
    ]);

    expect(listActive(state)).toHaveLength(0);
    expect(isFostered(state, 'local_origin-1', NEW_ACCOUNT)).toBe(false);
  });

  it('treats the same session in a different target account as a separate fostering', () => {
    const other = { accountUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', organizationUuid: 'x' };
    const state = project([
      { ...fostered, v: 1, ts: 10, toolVersion: '0.1.0' },
      // A real second copy always mints its own id (`mintSessionId`, global —
      // never scoped to a target account), which is what lets `active` be keyed
      // on the copy id alone. Reusing `local_copy-1` here would collide on that
      // key the way two real copies never do.
      {
        ...fostered,
        v: 1,
        ts: 20,
        toolVersion: '0.1.0',
        target: other,
        copySessionId: 'local_copy-2',
      },
    ]);

    expect(listActive(state)).toHaveLength(2);
  });

  it('records labels and ignores failures for state purposes', () => {
    const state = project([
      {
        kind: 'account_labelled',
        v: 1,
        ts: 1,
        toolVersion: '0.1.0',
        accountUuid: OLD_ACCOUNT.accountUuid,
        label: 'work',
      },
      {
        kind: 'failed',
        v: 1,
        ts: 2,
        toolVersion: '0.1.0',
        operation: 'foster',
        reason: 'app running',
      },
    ]);

    expect(state.labels.get(OLD_ACCOUNT.accountUuid)).toBe('work');
    expect(listActive(state)).toHaveLength(0);
  });
});

describe('selectByTarget', () => {
  const OTHER: AccountRef = {
    accountUuid: '22222222-2222-4222-8222-222222222222',
    organizationUuid: '22222222-2222-4222-8222-222222222223',
  };

  function copyInto(target: AccountRef, originSessionId: string): ActiveFostering {
    return {
      originSessionId,
      origin: OLD_ACCOUNT,
      target,
      copySessionId: `local_${originSessionId}`,
      copyPath: `/store/${target.accountUuid}/${originSessionId}.json`,
      fosteredAt: 1,
    };
  }

  const active = [copyInto(NEW_ACCOUNT, 'a1'), copyInto(NEW_ACCOUNT, 'a2'), copyInto(OTHER, 'b1')];

  it('keeps only the copies in the account named', () => {
    // The whole point: cleaning up an account you stopped using must not touch
    // the one you are in.
    const picked = selectByTarget(active, OTHER.accountUuid.slice(0, 8), undefined);
    expect(picked).toHaveLength(1);
    expect(picked[0]!.originSessionId).toBe('b1');
  });

  it('says where the copies actually are when the prefix matches none', () => {
    expect(() => selectByTarget(active, 'deadbeef', undefined)).toThrow(/No fostered copies/);
    expect(() => selectByTarget(active, 'deadbeef', undefined)).toThrow(
      new RegExp(`${NEW_ACCOUNT.accountUuid}  2 copies`),
    );
  });

  it('refuses a prefix that spans two accounts rather than guessing wide', () => {
    // Guessing here removes copies from an account nobody named.
    expect(() => selectByTarget(active, '', undefined)).toThrow(/ambiguous: it matches 2 accounts/);
  });

  it('narrows by organization on its own', () => {
    const picked = selectByTarget(active, undefined, OTHER.organizationUuid.slice(0, 8));
    expect(picked.map((f) => f.originSessionId)).toEqual(['b1']);
  });
});

/**
 * A title or flag foster rewrote on a card. The fold keeps what the app had,
 * however many sweeps have marked the card since, and forgets the card once it
 * is back to that.
 */
describe('card_retitled', () => {
  const marked = {
    kind: 'card_retitled' as const,
    sessionId: 'local_card-1',
    target: NEW_ACCOUNT,
    path: '/store/new/local_card-1.json',
    native: true,
    as: 'stale' as const,
  };
  const STALE = '(stale, stopped 01/09 18:10) Work';
  const LATER = '(stale, stopped 02/09 05:56) Work';

  it('is read back as an event', () => {
    const ledger = makeLedger();
    ledger.append({ ...marked, from: 'Work', to: STALE, fromArchived: false, toArchived: true });

    expect(ledger.read()[0]).toMatchObject({ kind: 'card_retitled', to: STALE });
  });

  it('folds to the card, carrying the original title and flag across repeated marks', () => {
    const ledger = makeLedger();
    ledger.append({ ...marked, from: 'Work', to: STALE, fromArchived: false, toArchived: true });
    ledger.append({ ...marked, from: STALE, to: LATER });

    expect(project(ledger.read()).retitled.get('local_card-1')).toMatchObject({
      from: 'Work',
      to: LATER,
      fromArchived: false,
      toArchived: true,
    });
  });

  it('drops the card once it is back to what the app had', () => {
    const ledger = makeLedger();
    ledger.append({ ...marked, from: 'Work', to: STALE, fromArchived: false, toArchived: true });
    ledger.append({
      ...marked,
      from: STALE,
      to: 'Work',
      fromArchived: true,
      toArchived: false,
      as: 'tip',
    });

    expect(project(ledger.read()).retitled.size).toBe(0);
  });

  /**
   * A copy made from a card that was already marked was recorded with the mark
   * inside the title homecoming first saw, so the branch pass marking it again lands
   * on exactly that string. Reading that as "back to what the app had" would drop
   * the record of the mark just written, and the title sync running next in the
   * same sweep would then strip a mark nothing proves is one — a mark-and-strip loop.
   * Only a write that undoes a mark can put a card back.
   */
  it('keeps a marking write that lands on the title the card was first seen with', () => {
    const ledger = makeLedger();
    ledger.append({ ...marked, from: STALE, to: 'Work', as: 'synced' });
    ledger.append({ ...marked, from: 'Work', to: STALE });

    expect(project(ledger.read()).retitled.get('local_card-1')).toMatchObject({
      from: STALE,
      to: STALE,
      markedTo: STALE,
    });
  });

  it('keeps the card while the title is back but the flag is not', () => {
    const ledger = makeLedger();
    ledger.append({ ...marked, from: 'Work', to: STALE, fromArchived: false, toArchived: true });
    ledger.append({ ...marked, from: STALE, to: 'Work', as: 'tip' });

    expect(project(ledger.read()).retitled.get('local_card-1')).toMatchObject({
      to: 'Work',
      toArchived: true,
    });
  });

  /**
   * the own field: the template a mark was made from, so a later run
   * recognises it whatever words that run was itself given. Optional so an
   * old log — written before this existed — still folds.
   */
  it('round-trips the optional template field', () => {
    const ledger = makeLedger();
    ledger.append({
      ...marked,
      from: 'Work',
      to: STALE,
      fromArchived: false,
      toArchived: true,
      template: '(stale, stopped {when}) ',
    });

    expect(ledger.read()[0]).toMatchObject({
      kind: 'card_retitled',
      template: '(stale, stopped {when}) ',
    });
  });

  it('still folds an old event that carries no template at all', () => {
    const ledger = makeLedger();
    ledger.append({ ...marked, from: 'Work', to: STALE, fromArchived: false, toArchived: true });

    const events = ledger.read();
    expect((events[0] as { template?: string }).template).toBeUndefined();
    expect(project(events).retitled.get('local_card-1')).toMatchObject({ from: 'Work', to: STALE });
  });
});

describe('worktree_released / worktree_release_undone', () => {
  const released = {
    kind: 'worktree_released' as const,
    path: 'C:\\home\\repo\\.claude\\worktrees\\wt-a\\local_card-1.json',
    sessionId: 'local_card-1',
    worktreePath: 'C:\\home\\repo\\.claude\\worktrees\\wt-a',
    worktreeName: 'wt-a',
    cwdFrom: 'C:\\home\\repo\\.claude\\worktrees\\wt-a',
    cwdTo: 'C:\\home\\repo',
  };

  it('is read back as an event', () => {
    const ledger = makeLedger();
    ledger.append(released);

    expect(ledger.read()[0]).toMatchObject({ kind: 'worktree_released', path: released.path });
  });

  it('folds to the copy, keyed by path', () => {
    const ledger = makeLedger();
    ledger.append(released);

    // Keyed by `comparablePath`, the same normalisation every other lookup in
    // this fold uses — two spellings of one file must land on one entry.
    const card = project(ledger.read()).worktreeReleased.get(comparablePath(released.path));
    expect(card).toMatchObject({
      sessionId: 'local_card-1',
      worktreePath: released.worktreePath,
      worktreeName: released.worktreeName,
      cwdFrom: released.cwdFrom,
      cwdTo: released.cwdTo,
    });
  });

  it('drops the card once the release is undone', () => {
    const ledger = makeLedger();
    ledger.append(released);
    ledger.append({ kind: 'worktree_release_undone', path: released.path });

    expect(project(ledger.read()).worktreeReleased.size).toBe(0);
  });
});
