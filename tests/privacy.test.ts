import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * scripts/privacy.mjs, run as the real CLI against a throwaway git
 * repository — never against this one: a fixture holding a real-looking
 * path or UUID would trip the very guard it is testing, and `npm run
 * privacy` would then fail on *this* file. The forbidden strings below are
 * therefore assembled at runtime (never spelled contiguously in the source).
 *
 * The denylist the guard checks names against is not in this repository, in
 * any encoding: a guard that ships the names it guards publishes them. These
 * tests hand it a synthetic list through the environment.
 *
 * `git grep` alone only sees tracked files, so a fixture written but not yet
 * `git add`-ed would pass `npm run privacy` and only fail once CI saw it
 * tracked, after the push. These tests plant an *untracked* file and
 * expect the guard to still catch it — the case that cost a rewrite.
 */

const SCRIPT = fileURLToPath(new URL('../scripts/privacy.mjs', import.meta.url));
// 'C:' + '\Users\' + 'jsmith' + '\file' — split so the literal never appears
// contiguously here.
const WINDOWS_PATH = `const p = 'C:${'\\'}Users${'\\'}jsmith${'\\'}file';\n`;
// A realistic-looking UUID, assembled from parts so no 8-4-4-4-12 hex run
// appears contiguously in this file.
const FAKE_UUID = ['4f8a2c11', '9b3d', '4e6a', '8f21', '7c5d9a01b3e4'].join('-');

let repo: string;

function git(...args: string[]) {
  execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
}

/** A synthetic denylist: a plain word, a pattern, and an author name. */
const DENYLIST = ['acme-private', 're:zeta[0-9]', 'author:jdoe'].join('\n');

/**
 * Runs the guard the way `npm run privacy` does, but rooted at `repo`, with
 * the caller's own denylist variables cleared so a real list never leaks in.
 */
function runGuard(env: Record<string, string> = {}): { ok: boolean; output: string } {
  const base = { ...process.env };
  delete base.PRIVACY_DENYLIST;
  delete base.PRIVACY_DENYLIST_FILE;
  delete base.PRIVACY_REQUIRE_DENYLIST;
  try {
    const output = execFileSync('node', [SCRIPT], {
      cwd: repo,
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...base, ...env },
    });
    return { ok: true, output };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'homecoming-privacy-'));
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(path.join(repo, '.gitignore'), 'ignored/\n');
  writeFileSync(path.join(repo, 'README.md'), 'nothing to see here\n');
  git('add', '.');
  git('commit', '-q', '-m', 'initial');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('scripts/privacy.mjs', () => {
  it('passes a repository with nothing but synthetic identifiers', () => {
    writeFileSync(
      path.join(repo, 'fixture.ts'),
      "const accountUuid = '00000000-0000-4000-8000-00000000000a';\n",
    );
    git('add', 'fixture.ts');
    expect(runGuard().ok).toBe(true);
  });

  it('catches a real-looking Windows profile path in an untracked file', () => {
    // Deliberately never `git add`-ed: this is the case plain `git grep`
    // (tracked files only) would miss.
    writeFileSync(path.join(repo, 'untracked.ts'), WINDOWS_PATH);
    const { ok, output } = runGuard();
    expect(ok).toBe(false);
    expect(output).toContain('C:\\Users\\<name>');
    expect(output).toContain('untracked.ts');
  });

  it('catches a realistic UUID in an untracked file', () => {
    writeFileSync(path.join(repo, 'untracked.ts'), `const accountUuid = '${FAKE_UUID}';\n`);
    const { ok, output } = runGuard();
    expect(ok).toBe(false);
    expect(output).toContain('realistic UUID');
    expect(output).toContain('untracked.ts');
  });

  it('catches a real-looking path already staged, not just committed', () => {
    writeFileSync(path.join(repo, 'staged.ts'), WINDOWS_PATH);
    git('add', 'staged.ts');
    expect(runGuard().ok).toBe(false);
  });

  it('never sees an untracked file that .gitignore excludes', () => {
    mkdirSync(path.join(repo, 'ignored'));
    writeFileSync(path.join(repo, 'ignored', 'secret.ts'), WINDOWS_PATH);
    expect(runGuard().ok).toBe(true);
  });

  it('catches a denylisted word, spelled any case, in an untracked file, and never prints it', () => {
    writeFileSync(path.join(repo, 'notes.md'), 'config lives in ~/ACME-PRIVATE\n');
    const { ok, output } = runGuard({ PRIVACY_DENYLIST: DENYLIST });
    expect(ok).toBe(false);
    expect(output).toContain('denylisted name');
    expect(output).toContain('notes.md');
    expect(output.toLowerCase()).not.toContain('acme-private');
  });

  it('matches a re: entry as a pattern', () => {
    writeFileSync(path.join(repo, 'notes.md'), 'host zeta7 is down\n');
    expect(runGuard({ PRIVACY_DENYLIST: DENYLIST }).ok).toBe(false);
  });

  it('reads the list from PRIVACY_DENYLIST_FILE, outside the repository', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'homecoming-denylist-'));
    try {
      const file = path.join(outside, 'list.txt');
      writeFileSync(file, `# a comment\n${DENYLIST}\n`);
      writeFileSync(path.join(repo, 'notes.md'), 'acme-private\n');
      expect(runGuard({ PRIVACY_DENYLIST_FILE: file }).ok).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('reads .privacy-denylist at the root when nothing else names a list', () => {
    writeFileSync(path.join(repo, '.gitignore'), 'ignored/\n.privacy-denylist\n');
    writeFileSync(path.join(repo, '.privacy-denylist'), DENYLIST);
    writeFileSync(path.join(repo, 'notes.md'), 'acme-private\n');
    expect(runGuard().ok).toBe(false);
  });

  it('checks the guard script itself for denylisted names', () => {
    // The old guard left scripts/privacy.mjs out of every rule, which is where
    // an encoded copy of the names used to live.
    mkdirSync(path.join(repo, 'scripts'));
    writeFileSync(path.join(repo, 'scripts', 'privacy.mjs'), "const x = 'acme-private';\n");
    const { ok, output } = runGuard({ PRIVACY_DENYLIST: DENYLIST });
    expect(ok).toBe(false);
    expect(output).toContain('scripts/privacy.mjs');
  });

  it('skips the denylist rule, saying so, when there is no list', () => {
    writeFileSync(path.join(repo, 'notes.md'), 'acme-private\n');
    const { ok, output } = runGuard();
    expect(ok).toBe(true);
    expect(output).toContain('no denylist');
  });

  it('fails without a list when PRIVACY_REQUIRE_DENYLIST=1', () => {
    expect(runGuard({ PRIVACY_REQUIRE_DENYLIST: '1' }).ok).toBe(false);
  });

  it('allows an author: entry in LICENSE and package.json, and nowhere else', () => {
    writeFileSync(path.join(repo, 'LICENSE'), 'Copyright 2026 Jdoe Someone\n');
    writeFileSync(path.join(repo, 'package.json'), '{ "author": "Jdoe Someone" }\n');
    expect(runGuard({ PRIVACY_DENYLIST: DENYLIST }).ok).toBe(true);

    writeFileSync(path.join(repo, 'src.ts'), '// jdoe wrote this\n');
    const { ok, output } = runGuard({ PRIVACY_DENYLIST: DENYLIST });
    expect(ok).toBe(false);
    expect(output).toContain('src.ts');
  });

  it('matches an author: entry only as a whole word', () => {
    writeFileSync(path.join(repo, 'src.ts'), '// jdoes and ajdoe are other words\n');
    expect(runGuard({ PRIVACY_DENYLIST: DENYLIST }).ok).toBe(true);
  });

  it('ships no list of its own, in any encoding', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    expect(source).not.toMatch(/base64|Buffer\.from|atob\(/);
    // No long quoted run of base64-looking characters either.
    expect(source).not.toMatch(/'[A-Za-z0-9+/]{8,}={0,2}'/);
  });
});
