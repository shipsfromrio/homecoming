import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { candidateStoreRoots } from '../src/domain/paths.js';
import { defaultLedgerPath } from '../src/ledger/log.js';
import { cacheFile, updateChecksDisabled } from '../src/update.js';
import { configDirCandidates } from '../src/store/configDirs.js';

/**
 * tests/setup.ts is the only thing standing between a test that relies on a
 * default and the real machine. These fail if any of the variables it
 * neutralises leaks through from the environment the suite was started in.
 */
describe('the test environment', () => {
  const inTemp = (value: string | undefined) =>
    value !== undefined && path.resolve(value).startsWith(path.resolve(tmpdir()));

  it('points every default home at a temporary directory', () => {
    expect(inTemp(homedir())).toBe(true);
    expect(inTemp(process.env.LOCALAPPDATA)).toBe(true);
    expect(inTemp(process.env.APPDATA)).toBe(true);
    expect(inTemp(process.env.FOSTER_HOME)).toBe(true);
  });

  it('finds no real Claude Desktop store and no real config directory', () => {
    expect(candidateStoreRoots()).toEqual([]);
    expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(process.env.CLAUDE_USER_DATA_DIR).toBeUndefined();
    expect(configDirCandidates().every((dir) => inTemp(dir))).toBe(true);
  });

  it('keeps the ledger and the update cache off the real profile, and the network off', () => {
    expect(inTemp(defaultLedgerPath())).toBe(true);
    expect(inTemp(cacheFile())).toBe(true);
    expect(updateChecksDisabled()).toBe(true);
  });
});
