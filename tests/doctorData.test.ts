import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Ledger } from '../src/ledger/log.js';
import {
  doctorTopLevelJson,
  registerDoctorCheck,
  runDoctorChecks,
  type Unregister,
} from '../src/extensions.js';
import { makeStore } from './helpers/store.js';

const RESERVED = ['version', 'store', 'candidates', 'account', 'appRunning', 'checks', 'cache'];

let undo: Unregister[] = [];

afterEach(() => {
  for (const step of undo.reverse()) step();
  undo = [];
});

function context() {
  return {
    store: makeStore(),
    ledger: new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'hc-doc-')), 'l.jsonl')),
  };
}

describe('doctor data', () => {
  it("carries a finding's data through runDoctorChecks", () => {
    undo.push(
      registerDoctorCheck({
        name: 'Detail',
        run: () => [{ level: 'info', message: 'three of them', data: { count: 3 } }],
      }),
    );
    expect(runDoctorChecks(context())).toEqual([
      {
        name: 'Detail',
        findings: [{ level: 'info', message: 'three of them', data: { count: 3 } }],
      },
    ]);
  });

  it('adds nothing at the top level without a check that declares json', () => {
    expect(doctorTopLevelJson(context(), RESERVED)).toEqual({});
    undo.push(registerDoctorCheck({ name: 'Plain', run: () => [] }));
    expect(doctorTopLevelJson(context(), RESERVED)).toEqual({});
  });

  it("merges a check's keys and refuses the core's and an earlier check's", () => {
    undo.push(
      registerDoctorCheck({
        name: 'First',
        run: () => [],
        json: () => ({ extra: { ok: true }, version: 'hijacked', checks: [] }),
      }),
      registerDoctorCheck({ name: 'Second', run: () => [], json: () => ({ extra: 'late' }) }),
    );
    const ctx = context();
    const results = runDoctorChecks(ctx);
    expect(doctorTopLevelJson(ctx, RESERVED, results)).toEqual({ extra: { ok: true } });
    const warnings = results.flatMap((result) =>
      result.findings
        .filter((finding) => finding.level === 'warn')
        .map((finding) => result.name + ': ' + finding.message),
    );
    expect(warnings).toEqual([
      'First: JSON key "version" is already taken; left out',
      'First: JSON key "checks" is already taken; left out',
      'Second: JSON key "extra" is already taken; left out',
    ]);
  });

  it('turns a json that throws into an error finding instead of failing', () => {
    undo.push(
      registerDoctorCheck({
        name: 'Fragile',
        run: () => [{ level: 'ok', message: 'fine' }],
        json: () => {
          throw new Error('cannot read it');
        },
      }),
      registerDoctorCheck({ name: 'Steady', run: () => [], json: () => ({ steady: 1 }) }),
    );
    const ctx = context();
    const results = runDoctorChecks(ctx);
    expect(doctorTopLevelJson(ctx, RESERVED, results)).toEqual({ steady: 1 });
    expect(results.find((result) => result.name === 'Fragile')?.findings).toEqual([
      { level: 'ok', message: 'fine' },
      { level: 'error', message: 'cannot read it' },
    ]);
    // Without a results list it is still not fatal.
    expect(() => doctorTopLevelJson(ctx, RESERVED)).not.toThrow();
  });
});
