import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The README's "Extending it" shows `import ... from 'homecoming'`. That import
 * only resolves if the package is installed, and homecoming is not on npm: the
 * section has to say how to get it (the release tarball) and must never tell
 * anyone to run an install that fails.
 */
const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const readme = read('README.md');
const release = read('.github/workflows/release.yml');
const version = (JSON.parse(read('package.json')) as { version: string }).version;

function section(title: string): string {
  const start = readme.indexOf(`## ${title}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = readme.indexOf('\n## ', start + 1);
  return readme.slice(start, end < 0 ? undefined : end);
}

describe('README: Extending it', () => {
  const extending = section('Extending it');

  it('never tells anyone to install the package from npm', () => {
    const commands = extending.split('\n').filter((line) => /^\s*npm (install|i|add)\b/.test(line));
    for (const line of commands) expect(line).not.toMatch(/^\s*npm (install|i|add) homecoming\s*$/);
    expect(extending).toMatch(/not published to npm/);
  });

  it("installs from this version's release tarball", () => {
    expect(extending).toContain(
      `https://github.com/shipsfromrio/homecoming/releases/download/v${version}/homecoming-${version}.tgz`,
    );
  });

  it('names a tarball the release workflow actually packs and attaches', () => {
    expect(release).toMatch(/run: npm pack\b/);
    expect(release).toMatch(/gh release create[\s\S]*homecoming-\*\.tgz/);
  });
});

/**
 * The app's `config.json` holds its cached sign-in token next to the id of the
 * signed-in account. The core reads that file for the account id and does not
 * extract the token, so "no token cache is ever read" or "no credential file
 * is opened" would over-claim: the docs have to name the file and say the
 * token itself is not read. Presence of a token entry is a plugin's question.
 */
describe('the credential claim says what is actually read', () => {
  const safety = section('Safety');
  const model = read('docs/guide/safety-model.md');
  const overClaim =
    /\b(token cache|credential file)s?\b[^.]*\b(ever read|opened)\b|never reads a credential/i;

  it('README: Safety names config.json and does not claim the core reads the token', () => {
    expect(safety).not.toMatch(overClaim);
    expect(safety).toContain('`config.json`');
    expect(safety).toMatch(/does not read it/);
    expect(safety).toMatch(/never its value/);
    expect(safety).toContain('`credentialProbes`');
  });

  it('safety model: same claim, same file named', () => {
    expect(model).not.toMatch(overClaim);
    expect(model).toMatch(/`config\.json`[^.]*sign-in token/);
    expect(model).toMatch(/does not read the\s+token/);
    expect(model).toContain('`credentialProbes`');
  });
});
