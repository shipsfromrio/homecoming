import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Ledger } from '../src/ledger/log.js';
import {
  configDirCandidates,
  registerConfigDirProvider,
  useLedgerForConfigDirs,
  type ConfigDirProvider,
} from '../src/store/configDirs.js';
import { makeStore } from './helpers/store.js';

/**
 * The ledger a config dir provider is handed: whatever `useLedgerForConfigDirs`
 * last set, or nothing. A provider written for two arguments keeps working.
 */

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  useLedgerForConfigDirs(undefined);
});

describe('config dir providers and the ledger', () => {
  it('a provider receives the ledger set for this run', () => {
    const ledger = new Ledger(path.join(makeStore().root, 'ledger.jsonl'));
    let seen: Ledger | undefined | 'never called' = 'never called';
    const provider: ConfigDirProvider = (_env, _home, context) => {
      seen = context?.ledger;
      return [];
    };
    cleanups.push(registerConfigDirProvider(provider));

    useLedgerForConfigDirs(ledger);
    configDirCandidates({}, [], '/home/someone');
    expect(seen).toBe(ledger);
  });

  it('receives undefined when no ledger was set', () => {
    let seen: Ledger | undefined | 'never called' = 'never called';
    cleanups.push(
      registerConfigDirProvider((_env, _home, context) => {
        seen = context?.ledger;
        return [];
      }),
    );

    configDirCandidates({}, [], '/home/someone');
    expect(seen).toBeUndefined();
  });

  it('clearing the ledger gives providers undefined again', () => {
    const ledger = new Ledger(path.join(makeStore().root, 'ledger.jsonl'));
    let seen: Ledger | undefined;
    cleanups.push(
      registerConfigDirProvider((_env, _home, context) => {
        seen = context?.ledger;
        return [];
      }),
    );

    useLedgerForConfigDirs(ledger);
    useLedgerForConfigDirs(undefined);
    configDirCandidates({}, [], '/home/someone');
    expect(seen).toBeUndefined();
  });

  it('a two-argument provider still adds its directories', () => {
    const legacy = (env: NodeJS.ProcessEnv, home: string): string[] => [
      path.join(home, env.EXTRA_NAME ?? 'extra'),
    ];
    cleanups.push(registerConfigDirProvider(legacy));
    useLedgerForConfigDirs(new Ledger(path.join(makeStore().root, 'ledger.jsonl')));

    expect(configDirCandidates({ EXTRA_NAME: 'more' }, [], '/home/someone')).toContain(
      path.join('/home/someone', 'more'),
    );
  });

  it('a provider can pick directories from what the ledger holds', () => {
    const ledger = new Ledger(path.join(makeStore().root, 'ledger.jsonl'));
    ledger.append({ kind: 'account_labelled', accountUuid: 'acct', label: 'second' });
    cleanups.push(
      registerConfigDirProvider((_env, home, context) =>
        (context?.ledger?.read() ?? []).flatMap((event) =>
          event.kind === 'account_labelled' ? [path.join(home, `.cli-${event.label}`)] : [],
        ),
      ),
    );

    expect(configDirCandidates({}, [], '/home/someone')).not.toContain(
      path.join('/home/someone', '.cli-second'),
    );
    useLedgerForConfigDirs(ledger);
    expect(configDirCandidates({}, [], '/home/someone')).toContain(
      path.join('/home/someone', '.cli-second'),
    );
  });
});
