#!/usr/bin/env node
/**
 * The privacy guard, runnable before pushing rather than only in CI.
 *
 * This repository is public, and a real account identifier or a personal path in
 * a fixture is not the kind of mistake a review catches reliably: it looks
 * exactly like the synthetic ones beside it. `.github/workflows/ci.yml` and
 * `release.yml` run this same file, so there is one implementation of the rules.
 *
 * It sees what the next `git add -A` would commit: tracked, staged, and
 * untracked-but-not-ignored files alike (`git ls-files --others
 * --exclude-standard`, `git grep --untracked`). A fixture written but not yet
 * added is exactly the one that slips through a tracked-only check.
 *
 * Three rules:
 *
 * 1. No Windows user-profile path (`C:\Users\<name>`), in any spelling.
 * 2. No realistic UUID. Fixtures use obviously synthetic ones.
 * 3. No entry from a denylist, which is NOT kept in this repository. A guard
 *    that ships the names it guards publishes them, whatever the encoding. The
 *    list comes from `PRIVACY_DENYLIST` (CI passes a repository secret) or from
 *    the file named by `PRIVACY_DENYLIST_FILE`, by default `.privacy-denylist`
 *    at the repository root, which `.gitignore` excludes. Without either, the
 *    rule is skipped and the run says so, unless `PRIVACY_REQUIRE_DENYLIST=1`
 *    (the release workflow sets it), which makes a missing list a failure.
 *
 * Denylist format, one entry per line or separated by commas; `#` starts a
 * comment:
 *
 *   word          matched anywhere, case-insensitively
 *   re:pattern    a JavaScript regular expression, case-insensitive
 *   author:word   a whole word, allowed only in LICENSE and package.json
 *
 * On a hit only file names are printed, never the entry: CI logs on a public
 * repository are public too.
 *
 *   node scripts/privacy.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const UUID = '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}';
/** Long runs of one hex digit, which no real identifier contains. */
const SYNTHETIC = /(0{4,}|1{4,}|2{4,}|a{4,}|f{4,}|deadbeef)/i;
/**
 * Left out of the path and UUID rules only: this file spells the patterns, and
 * the lockfile is full of integrity hashes. The denylist rule reads every file,
 * this one included, so a name cannot hide in the guard itself.
 */
const EXCLUDED = ['scripts/privacy.mjs', 'package-lock.json'];
const SCOPE = ['--', '.', ...EXCLUDED.map((file) => `:(exclude)${file}`)];
const AUTHOR_ALLOWED = new Set(['LICENSE', 'package.json']);

/** git grep exits 1 when it matches nothing, which is the good case here. */
function grep(args) {
  try {
    return execFileSync('git', ['grep', '--untracked', ...args, ...SCOPE], { encoding: 'utf8' });
  } catch {
    return '';
  }
}

let failed = false;

// Windows user-profile paths, in the single-backslash form used in prose, the
// doubled form used inside string literals, and the forward-slash spelling.
const paths = grep(['-nIiE', String.raw`C:[\\/]+Users[\\/]+[A-Za-z0-9._-]+`]);
if (paths.trim()) {
  console.error('A literal C:\\Users\\<name> path is in a file:\n');
  console.error(paths.trim());
  failed = true;
}

// Each identifier is judged on its own: filtering whole lines would let a real
// one through whenever a synthetic one shared the line.
const found = new Set(
  grep(['-hoIiE', UUID])
    .split('\n')
    .map((line) => line.trim())
    .filter((id) => id && !SYNTHETIC.test(id)),
);

if (found.size > 0) {
  console.error(`\n${found.size} realistic UUID(s): fixtures must be obviously synthetic:\n`);
  for (const id of found) {
    console.error(`  ${id}`);
    console.error(grep(['-nI', id]).trimEnd());
  }
  failed = true;
}

function denylistText(top) {
  if (process.env.PRIVACY_DENYLIST) return process.env.PRIVACY_DENYLIST;
  const file = process.env.PRIVACY_DENYLIST_FILE ?? path.join(top, '.privacy-denylist');
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
}

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Each entry as a case-insensitive pattern, and whether the author files may carry it. */
function parseDenylist(text) {
  return text
    .split(/[\n,]/)
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean)
    .map((entry) => {
      if (entry.startsWith('re:')) return { pattern: new RegExp(entry.slice(3), 'i') };
      if (entry.startsWith('author:')) {
        const word = escape(entry.slice('author:'.length));
        return {
          pattern: new RegExp(`(^|[^\\p{L}\\p{N}])${word}($|[^\\p{L}\\p{N}])`, 'iu'),
          author: true,
        };
      }
      return { pattern: new RegExp(escape(entry), 'i') };
    });
}

const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const denylist = denylistText(top);
if (denylist === undefined && process.env.PRIVACY_REQUIRE_DENYLIST === '1') {
  console.error(
    'privacy: PRIVACY_REQUIRE_DENYLIST=1 and no denylist (PRIVACY_DENYLIST, PRIVACY_DENYLIST_FILE or .privacy-denylist).',
  );
  failed = true;
} else if (denylist === undefined) {
  console.log(
    'privacy: no denylist (PRIVACY_DENYLIST, PRIVACY_DENYLIST_FILE or .privacy-denylist); only paths and UUIDs were checked.',
  );
} else {
  const entries = parseDenylist(denylist);
  const files = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: top,
      encoding: 'utf8',
    },
  )
    .split('\0')
    .filter(Boolean);
  const hits = new Set();
  for (const file of files) {
    let body;
    try {
      body = readFileSync(path.join(top, file), 'utf8');
    } catch {
      continue; // deleted in the working tree but still in the index
    }
    for (const entry of entries) {
      if (entry.author && AUTHOR_ALLOWED.has(file)) continue;
      if (entry.pattern.test(body)) hits.add(file);
    }
  }
  if (hits.size > 0) {
    console.error('\nA denylisted name is in:\n');
    for (const file of [...hits].sort()) console.error(`  ${file}`);
    failed = true;
  }
}

if (failed) {
  console.error('\nReplace them with synthetic values like 00000000-0000-4000-8000-00000000000a.');
  process.exit(1);
}

console.log('privacy: no personal identifiers in tracked or untracked files.');
