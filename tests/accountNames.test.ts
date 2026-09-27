import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Ledger } from '../src/ledger/log.js';
import { labelsOf, manualLabelsOf, registerAccountNamer } from '../src/cli/names.js';

/**
 * An account can be named two ways: a label a person chose, and whatever a
 * registered namer knows (an e-mail, a display name). These are about the order
 * between the two, and about taking a namer away again.
 */

const HERS = '11111111-1111-4111-8111-111111111111';
const HIS = '22222222-2222-4222-8222-222222222222';
const NOBODY = '00000000-0000-4000-8000-00000000000c';

function ledger(): Ledger {
  return new Ledger(
    path.join(mkdtempSync(path.join(tmpdir(), 'homecoming-names-')), 'ledger.jsonl'),
  );
}

const cleanups: (() => void)[] = [];
function namer(names: Record<string, string>): void {
  cleanups.push(registerAccountNamer(() => new Map(Object.entries(names))));
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe('the name an account goes by', () => {
  it('uses what a namer knows when nobody has named the account', () => {
    namer({ [HERS]: 'her@x.test' });
    expect(labelsOf(ledger()).get(HERS)).toBe('her@x.test');
  });

  it('prefers a label a person chose over what a namer knows', () => {
    namer({ [HERS]: 'her@x.test' });
    const log = ledger();
    log.append({ kind: 'account_labelled', accountUuid: HERS, label: 'Work' });

    expect(labelsOf(log).get(HERS)).toBe('Work');
  });

  it('lets the first registered namer win over a later one', () => {
    namer({ [HIS]: 'first' });
    namer({ [HIS]: 'second' });
    expect(labelsOf(ledger()).get(HIS)).toBe('first');
  });

  it('forgets a namer once it is unregistered', () => {
    namer({ [HIS]: 'Him' });
    expect(labelsOf(ledger()).get(HIS)).toBe('Him');
    cleanups.pop()!();
    expect(labelsOf(ledger()).get(HIS)).toBeUndefined();
  });

  it('names nothing it has never seen, so the caller can still fall back to the uuid', () => {
    expect(labelsOf(ledger()).get(NOBODY)).toBeUndefined();
  });

  it("gives the namer's answer back when the chosen label is cleared", () => {
    namer({ [HERS]: 'her@x.test' });
    const log = ledger();
    log.append({ kind: 'account_labelled', accountUuid: HERS, label: 'Work' });
    // What `label --clear` writes: the log is append-only, so taking a name back
    // is a line saying so, not a line removed.
    log.append({ kind: 'account_labelled', accountUuid: HERS, label: '' });

    expect(labelsOf(log).get(HERS)).toBe('her@x.test');
    expect(manualLabelsOf(log).get(HERS)).toBeUndefined();
  });

  it('leaves an account with nothing at all when the cleared label was its only name', () => {
    const log = ledger();
    log.append({ kind: 'account_labelled', accountUuid: NOBODY, label: 'Spare' });
    log.append({ kind: 'account_labelled', accountUuid: NOBODY, label: '' });

    expect(labelsOf(log).get(NOBODY)).toBeUndefined();
  });

  it('keeps the chosen labels apart, for the JSON field that promises exactly those', () => {
    namer({ [HERS]: 'her@x.test' });
    const log = ledger();
    log.append({ kind: 'account_labelled', accountUuid: HIS, label: 'Work' });

    const manual = manualLabelsOf(log);
    expect(manual.get(HIS)).toBe('Work');
    expect(manual.get(HERS)).toBeUndefined();
  });
});
