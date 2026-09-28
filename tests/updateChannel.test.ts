import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cacheFile,
  checkForUpdate,
  DEFAULT_UPDATE_REPO,
  installCommandFor,
  registerUpdateChannel,
  updateRepo,
  type UpdateChannel,
} from '../src/update.js';

/**
 * The update channel: where a build that is not this repository's own checks
 * for and installs releases. One at most; with none, the core's repository,
 * cache and command, exactly as before.
 */

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});
function use(channel: UpdateChannel): void {
  cleanups.push(registerUpdateChannel(channel));
}

/** An environment whose cache lives in a fresh directory, with checks on. */
function freshEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { FOSTER_HOME: mkdtempSync(path.join(tmpdir(), 'homecoming-channel-')), ...extra };
}

describe('update channel', () => {
  it('with none registered, the core repository, cache and command', () => {
    const env = freshEnv();
    expect(updateRepo(env)).toBe(DEFAULT_UPDATE_REPO);
    expect(path.basename(cacheFile(env))).toBe('update-check.json');
    expect(installCommandFor('v1.2.3', DEFAULT_UPDATE_REPO)).toContain(
      `${DEFAULT_UPDATE_REPO}/v1.2.3/install.ps1`,
    );
  });

  it('names the repository, as a string or from the environment', () => {
    use({ repo: (env) => env.CHANNEL_REPO ?? 'someone/else' });
    expect(updateRepo({})).toBe('someone/else');
    expect(updateRepo({ CHANNEL_REPO: 'another/place' })).toBe('another/place');
  });

  it('a repository not shaped like owner/name falls back to the core rule', () => {
    use({ repo: 'not a repo; rm -rf' });
    expect(updateRepo({})).toBe(DEFAULT_UPDATE_REPO);
    expect(updateRepo({ HOMECOMING_UPDATE_REPO: 'fork/build' })).toBe('fork/build');
  });

  it('keeps its answer in a cache of its own', async () => {
    const env = freshEnv();
    use({ repo: 'someone/else', cacheKey: 'side', fetchLatest: async () => 'v9.0.0' });

    expect(path.basename(cacheFile(env))).toBe('update-check-side.json');
    await checkForUpdate({ current: '1.0.0', env });
    expect(existsSync(path.join(env.FOSTER_HOME!, 'update-check-side.json'))).toBe(true);
    expect(existsSync(path.join(env.FOSTER_HOME!, 'update-check.json'))).toBe(false);
  });

  it('ignores a cache key that is not a plain file name', () => {
    use({ repo: 'someone/else', cacheKey: '../escape' });
    expect(path.basename(cacheFile(freshEnv()))).toBe('update-check.json');
  });

  it('asks its own fetchLatest with its repository', async () => {
    const fetchLatest = vi.fn(async () => 'v2.0.0');
    use({ repo: 'someone/else', fetchLatest });

    const status = await checkForUpdate({ current: '1.0.0', env: freshEnv() });
    expect(fetchLatest).toHaveBeenCalledWith('someone/else');
    expect(status?.latest).toBe('2.0.0');
    expect(status?.outdated).toBe(true);
  });

  it('a fetchLatest that throws is an unknown answer, never an exception', async () => {
    use({
      repo: 'someone/else',
      fetchLatest: async () => {
        throw new Error('offline');
      },
    });

    await expect(checkForUpdate({ current: '1.0.0', env: freshEnv() })).resolves.toBeUndefined();
  });

  it("the channel's install command is what the status reports", async () => {
    use({
      repo: 'someone/else',
      fetchLatest: async () => 'v2.0.0',
      installCommand: (tag, repo) => `install-from ${repo} ${tag}`,
    });

    const status = await checkForUpdate({ current: '1.0.0', env: freshEnv() });
    expect(status?.command).toBe('install-from someone/else v2.0.0');
  });

  it('an install command that throws falls back to the core command', async () => {
    use({
      repo: 'someone/else',
      fetchLatest: async () => 'v2.0.0',
      installCommand: () => {
        throw new Error('no idea');
      },
    });

    const status = await checkForUpdate({ current: '1.0.0', env: freshEnv() });
    expect(status?.command).toContain('someone/else/v2.0.0/install.ps1');
  });

  it('refuses a second channel, and accepts one again once the first is gone', () => {
    const undo = registerUpdateChannel({ repo: 'someone/else' });
    expect(() => registerUpdateChannel({ repo: 'another/place' })).toThrow(/already registered/);
    expect(updateRepo({})).toBe('someone/else');

    undo();
    expect(updateRepo({})).toBe(DEFAULT_UPDATE_REPO);
    use({ repo: 'another/place' });
    expect(updateRepo({})).toBe('another/place');
  });
});
