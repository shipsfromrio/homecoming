import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  cacheFile,
  checkForUpdate,
  DEFAULT_UPDATE_REPO,
  installCommandFor,
  isNewer,
  updateChecksDisabled,
  updateRepo,
} from '../src/update.js';

function scratchFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'homecoming-upd-')), 'update-check.json');
}

describe('isNewer', () => {
  it('compares each numeric component, not the string', () => {
    expect(isNewer('0.10.0', '0.9.0')).toBe(true);
    expect(isNewer('0.9.0', '0.10.0')).toBe(false);
  });

  it('tolerates a leading v and missing components', () => {
    expect(isNewer('v1.0.0', '0.2.2')).toBe(true);
    expect(isNewer('1.1', '1.0.9')).toBe(true);
  });

  it('treats equal versions as not newer', () => {
    expect(isNewer('0.2.2', '0.2.2')).toBe(false);
  });

  it('never suggests a pre-release to someone on the final version', () => {
    expect(isNewer('1.0.0-rc.1', '1.0.0')).toBe(false);
    expect(isNewer('1.0.0', '1.0.0-rc.1')).toBe(true);
  });
});

describe('checkForUpdate', () => {
  const fetchLatest = (tag: string | undefined) => vi.fn(async () => tag);

  it('reports an available release with the command that installs it', async () => {
    const status = await checkForUpdate({
      current: '0.2.2',
      file: scratchFile(),
      env: {},
      fetchLatest: fetchLatest('v0.3.0'),
    });

    expect(status).toMatchObject({ current: '0.2.2', latest: '0.3.0', outdated: true });
    expect(status?.command).toContain('/v0.3.0/install.ps1');
  });

  it('reports being current without suggesting anything', async () => {
    const status = await checkForUpdate({
      current: '0.2.2',
      file: scratchFile(),
      env: {},
      fetchLatest: fetchLatest('v0.2.2'),
    });

    expect(status?.outdated).toBe(false);
  });

  it('stays quiet when the answer is unknown, rather than claiming to be current', async () => {
    // Offline, proxied, rate-limited: a local tool must not be degraded by any of it.
    const status = await checkForUpdate({
      current: '0.2.2',
      file: scratchFile(),
      env: {},
      fetchLatest: fetchLatest(undefined),
    });

    expect(status).toBeUndefined();
  });

  it('never throws when the network layer does', async () => {
    const exploding = vi.fn(async () => {
      throw new Error('ENOTFOUND');
    });

    // A failed version check must never become the reason a foster run dies.
    await expect(
      checkForUpdate({ current: '0.2.2', file: scratchFile(), env: {}, fetchLatest: exploding }),
    ).resolves.toBeUndefined();
  });

  it('honours the opt-out without touching the network', async () => {
    const spy = fetchLatest('v9.9.9');

    const status = await checkForUpdate({
      current: '0.2.2',
      file: scratchFile(),
      env: { FOSTER_NO_UPDATE_CHECK: '1' },
      fetchLatest: spy,
    });

    expect(status).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('serves a fresh cache instead of asking again', async () => {
    const file = scratchFile();
    const now = 1_700_000_000_000;
    writeFileSync(file, JSON.stringify({ latest: 'v0.3.0', checkedAt: now - 1000 }), 'utf8');
    const spy = fetchLatest('v9.9.9');

    const status = await checkForUpdate({
      current: '0.2.2',
      file,
      env: {},
      now,
      fetchLatest: spy,
    });

    expect(status?.latest).toBe('0.3.0');
    expect(spy).not.toHaveBeenCalled();
  });

  it('asks again once the cache is a day old, and records the answer', async () => {
    const file = scratchFile();
    const now = 1_700_000_000_000;
    writeFileSync(
      file,
      JSON.stringify({ latest: 'v0.1.0', checkedAt: now - 25 * 60 * 60 * 1000 }),
      'utf8',
    );

    const status = await checkForUpdate({
      current: '0.2.2',
      file,
      env: {},
      now,
      fetchLatest: fetchLatest('v0.4.0'),
    });

    expect(status?.latest).toBe('0.4.0');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      latest: 'v0.4.0',
      checkedAt: now,
    });
  });

  it('survives an unreadable cache file', async () => {
    const file = scratchFile();
    writeFileSync(file, 'not json at all', 'utf8');

    const status = await checkForUpdate({
      current: '0.2.2',
      file,
      env: {},
      fetchLatest: fetchLatest('v0.3.0'),
    });

    expect(status?.latest).toBe('0.3.0');
  });
});

describe('updateChecksDisabled', () => {
  it('is off by default and on for meaningful values', () => {
    expect(updateChecksDisabled({})).toBe(false);
    expect(updateChecksDisabled({ FOSTER_NO_UPDATE_CHECK: '' })).toBe(false);
    expect(updateChecksDisabled({ FOSTER_NO_UPDATE_CHECK: '0' })).toBe(false);
    expect(updateChecksDisabled({ FOSTER_NO_UPDATE_CHECK: '1' })).toBe(true);
    expect(updateChecksDisabled({ FOSTER_NO_UPDATE_CHECK: 'yes' })).toBe(true);
  });
});

describe('installCommandFor', () => {
  it('pins the tag it was given', () => {
    expect(installCommandFor('v1.2.3')).toContain('/v1.2.3/install.ps1');
  });
});

describe('which repository is checked', () => {
  it('defaults to the published repository', () => {
    expect(updateRepo({})).toBe(DEFAULT_UPDATE_REPO);
    expect(installCommandFor('v1.0.0', updateRepo({}))).toContain(
      `raw.githubusercontent.com/${DEFAULT_UPDATE_REPO}/v1.0.0/`,
    );
  });

  it('takes an owner/name override, and ignores one that is not shaped like it', () => {
    expect(updateRepo({ HOMECOMING_UPDATE_REPO: 'someone/fork' })).toBe('someone/fork');
    expect(updateRepo({ HOMECOMING_UPDATE_REPO: 'https://evil.example/x' })).toBe(
      DEFAULT_UPDATE_REPO,
    );
  });

  it('builds the install command for the repository it checked', async () => {
    const status = await checkForUpdate({
      current: '1.0.0',
      file: scratchFile(),
      env: { HOMECOMING_UPDATE_REPO: 'someone/fork' },
      fetchLatest: async () => 'v1.1.0',
    });
    expect(status?.command).toContain('raw.githubusercontent.com/someone/fork/v1.1.0/');
  });

  it('does not answer from a cache another repository wrote', async () => {
    const file = scratchFile();
    writeFileSync(file, JSON.stringify({ latest: 'v9.9.9', checkedAt: Date.now() }), 'utf8');
    const fetchLatest = vi.fn(async () => 'v1.1.0');

    const status = await checkForUpdate({
      current: '1.0.0',
      file,
      env: { HOMECOMING_UPDATE_REPO: 'someone/fork' },
      fetchLatest,
    });

    expect(fetchLatest).toHaveBeenCalledOnce();
    expect(status?.latest).toBe('1.1.0');
  });

  it('keeps its cache under FOSTER_HOME', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'homecoming-home-'));
    expect(cacheFile({ FOSTER_HOME: home })).toBe(path.join(home, 'update-check.json'));
  });
});
