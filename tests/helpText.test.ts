import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Commander prints a command's description as written and then wraps every
 * line at the help width (80 columns when output is not a terminal). A hard
 * line break that leaves a line longer than that gets wrapped a second time,
 * and `--help` comes out ragged: a long line, a stub of two words, a long
 * line. So a paragraph is either left whole, for Commander to wrap, or broken
 * by hand into lines that each fit in 80 columns.
 *
 * Asserted against the source, the same way helpGroups.test.ts does: rendering
 * `--help` means spawning a process per command.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WIDTH = 80;

function cliSources(): string[] {
  const dir = path.join(ROOT, 'src', 'cli');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => path.join(dir, name));
}

/** The text of a string literal's body, escapes resolved; `${…}` becomes a short stand-in. */
function unescape(body: string, quote: string): string {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quote === '`' && ch === '$' && body[i + 1] === '{') {
      let depth = 0;
      let j = i + 1;
      for (; j < body.length; j++) {
        if (body[j] === '{') depth++;
        else if (body[j] === '}' && --depth === 0) break;
      }
      out += 'XXXX';
      i = j;
      continue;
    }
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = body[++i]!;
    out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
  }
  return out;
}

/**
 * Every `.description(...)` whose argument is built only from string literals,
 * with the file and line it starts on. A description computed from a variable
 * is skipped, not guessed at.
 */
function descriptions(file: string): { where: string; text: string }[] {
  const source = readFileSync(file, 'utf8');
  const found: { where: string; text: string }[] = [];
  for (const match of source.matchAll(/\.description\(/g)) {
    let i = match.index + match[0].length;
    let text = '';
    let literalOnly = true;
    let depth = 0;
    for (; i < source.length; i++) {
      const ch = source[i]!;
      if (ch === "'" || ch === '"' || ch === '`') {
        let j = i + 1;
        while (j < source.length && source[j] !== ch) j += source[j] === '\\' ? 2 : 1;
        if (depth === 0) text += unescape(source.slice(i + 1, j), ch);
        i = j;
      } else if (ch === '(') depth++;
      else if (ch === ')') {
        if (depth === 0) break;
        depth--;
      } else if (ch === ',' && depth === 0) break;
      else if (depth === 0 && /[A-Za-z_]/.test(ch)) literalOnly = false;
    }
    if (!literalOnly || text === '') continue;
    const line = source.slice(0, match.index).split('\n').length;
    found.push({ where: `${path.relative(ROOT, file)}:${line}`, text });
  }
  return found;
}

describe('help text', () => {
  const all = cliSources().flatMap(descriptions);

  it('finds descriptions at all, so the check cannot pass by matching nothing', () => {
    expect(all.length).toBeGreaterThan(30);
    expect(all.some((d) => d.text.includes('\n'))).toBe(true);
  });

  it('keeps every hard-wrapped line of a description within 80 columns', () => {
    // A paragraph with no break of its own is left to Commander, which wraps it
    // cleanly; only one the author broke by hand can come out ragged.
    const ragged = all.flatMap(({ where, text }) =>
      text
        .split('\n\n')
        .filter((paragraph) => paragraph.includes('\n'))
        .flatMap((paragraph) => paragraph.split('\n'))
        .filter((line) => line.length > WIDTH)
        .map((line) => `${where}: ${line.length} ${line.slice(0, 50)}…`),
    );
    expect(ragged).toEqual([]);
  });
});
