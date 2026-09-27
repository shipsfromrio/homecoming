import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * homecoming brings a person's own sessions from a previous local account into
 * the one they use now. Its help, docs and comments describe that and nothing
 * broader, and this file holds the vocabulary in place.
 *
 * Only one rule is spelled here: nothing points at an issue number, which a
 * fresh public repository cannot resolve. The other vocabulary rules are NOT
 * kept in this repository, for the same reason `scripts/privacy.mjs` keeps its
 * denylist out: a guard that ships the phrases it guards against publishes
 * them. They come from `WORDING_PROBES` (the entries inline) or from the file
 * named by `WORDING_PROBES_FILE`. Without either, those rules are skipped and
 * the run says so, unless `WORDING_REQUIRE_PROBES=1`, which makes a missing
 * list a failure.
 *
 * Entry format, one per line; `#` starts a comment, blank lines are ignored:
 *
 *   why<TAB>regex<TAB>probe[<TAB>flags]
 *
 * `probe` is a bare phrase the regex must match, so a rule cannot pass by
 * matching nothing. `flags` default to `i`; `-` means none. On a hit only the
 * rule's `why` and the file are reported, never the matched text.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

interface WordingRule {
  why: string;
  pattern: RegExp;
  probe: string;
}

const BUILT_IN: WordingRule[] = [
  {
    why: 'issue reference',
    pattern: /\bissues?\s+#\d+|\(#\d+\)|\bgh#\d+/i,
    probe: 'see issue #49',
  },
];

/** Parses the entry format above. A malformed line is an error, not a skip. */
function parseWordingRules(text: string): WordingRule[] {
  const rules: WordingRule[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const fields = line.split('\t').map((field) => field.trim());
    const [why, source, probe, flags = 'i'] = fields;
    if (!why || !source || !probe || fields.length > 4) {
      throw new Error(`wording probes, line ${index + 1}: expected why<TAB>regex<TAB>probe`);
    }
    rules.push({ why, pattern: new RegExp(source, flags === '-' ? '' : flags), probe });
  }
  return rules;
}

/** The external list, or undefined when nothing names one. */
function loadExternalText(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.WORDING_PROBES) return env.WORDING_PROBES;
  const file = env.WORDING_PROBES_FILE;
  if (file && existsSync(file)) return readFileSync(file, 'utf8');
  return undefined;
}

const externalText = loadExternalText();
const external = externalText === undefined ? [] : parseWordingRules(externalText);
const RULES = [...BUILT_IN, ...external];

if (externalText === undefined) {
  const message =
    'wording: WORDING_PROBES / WORDING_PROBES_FILE not set, so only the built-in rule runs';
  if (process.env.WORDING_REQUIRE_PROBES === '1') throw new Error(message);
  console.warn(message);
}

function filesUnder(dir: string, extension: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(relative, extension));
    else if (entry.name.endsWith(extension)) out.push(relative);
  }
  return out;
}

function offenders(text: string): string[] {
  return RULES.filter(({ pattern }) => pattern.test(text)).map(({ why }) => why);
}

const self = path.join('tests', 'wording.test.ts');

describe('wording rules: the loader', () => {
  it('reads why, regex, probe and optional flags, skipping comments and blanks', () => {
    const rules = parseWordingRules(
      ['# a comment', '', 'widgets\t\\bwidget\ta widget', 'Gadget\tGadget\tthe Gadget\t-'].join(
        '\n',
      ),
    );
    expect(rules.map((rule) => rule.why)).toEqual(['widgets', 'Gadget']);
    expect(rules[0]!.pattern.test('A WIDGET')).toBe(true);
    expect(rules[1]!.pattern.test('the gadget')).toBe(false);
  });

  it('refuses a malformed line rather than dropping the rule', () => {
    expect(() => parseWordingRules('widgets\t\\bwidget')).toThrow(/line 1/);
  });

  it('prefers the inline list over the file, and has nothing when neither is set', () => {
    expect(loadExternalText({ WORDING_PROBES: 'x\tx\tx', WORDING_PROBES_FILE: 'nope' })).toBe(
      'x\tx\tx',
    );
    expect(loadExternalText({})).toBeUndefined();
  });
});

describe('scope of the wording', () => {
  it('each rule matches its own probe, so the check cannot pass by matching nothing', () => {
    for (const { pattern, probe } of RULES) {
      expect(pattern.test(probe), String(pattern)).toBe(true);
    }
  });

  it.runIf(external.length > 0)('this file does not carry the external list in clear', () => {
    const text = readFileSync(path.join(ROOT, self), 'utf8');
    for (const rule of external) {
      expect(text.includes(rule.probe), rule.why).toBe(false);
      expect(text.includes(rule.pattern.source), rule.why).toBe(false);
    }
  });

  it.each(
    [
      ...filesUnder('src', '.ts'),
      ...filesUnder('tests', '.ts'),
      ...filesUnder('docs', '.md'),
      'README.md',
    ].filter((file) => file !== self),
  )('%s stays within scope', (file) => {
    expect(offenders(readFileSync(path.join(ROOT, file), 'utf8'))).toEqual([]);
  });
});
