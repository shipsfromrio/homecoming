import { readFileSync } from 'node:fs';
import type { StoreLayout } from '../domain/types.js';
import type { Unregister } from '../extensions.js';

/**
 * The settings this reader returns. It is deliberately narrow: a few plain
 * settings, copied out of the app's config file by name. Credential material
 * in that file is never extracted. Whether a sign-in token entry is present
 * is a plugin's question (`credentialProbes`); this reader does not look.
 */
const READABLE_KEYS = ['lastKnownAccountUuid', 'locale', 'updaterLastSeenVersion'] as const;

export interface StoreConfig {
  /** The account whose directory the sidebar is currently populated from. */
  lastKnownAccountUuid?: string;
  locale?: string;
  /**
   * The release the app's updater last saw. Not necessarily the running build —
   * after an update is staged but before relaunch it runs ahead of it.
   */
  updaterLastSeenVersion?: string;
  /**
   * Whether the app keeps a tray icon. This decides what closing the window does:
   * the window's close handler quits the app only when the tray is off, and
   * otherwise cancels the close and hides the window instead. Absent means on,
   * which is the default and the case that matters — see engine/desktop.ts.
   *
   * Read from `preferences.menuBarEnabled` in **`claude_desktop_config.json`**,
   * which is where the app keeps it. Two corrections deep, so both are worth
   * stating: measurement found that the preference sits inside a `preferences` object
   * rather than at the top level, and then that the object is in the app's
   * own settings file — the one holding the MCP server list — not in the
   * `config.json` that holds the account cache and the OAuth token. Measured by
   * switching the tray off in the app's own UI and watching which file changed.
   *
   * Both older readings stay as fallbacks, in that order. They cost nothing and
   * cover a build that kept the setting somewhere else; what they must not do is
   * come first. Read from the wrong file, this answered "tray on" for everyone —
   * right for the default, and wrong for exactly the people who turned the tray
   * off, who were told to `--terminate` an app that would have closed politely.
   */
  menuBarEnabled?: boolean;
}

/**
 * Whether a store's config carries a cached sign-in token. Presence only: a
 * probe must not return, log or copy the token. The core ships with none, so
 * nothing in the core looks.
 */
export interface CredentialProbe {
  name: string;
  hasTokenCache(store: StoreLayout): boolean;
}

const credentialProbes: CredentialProbe[] = [];

/** Registers a probe. Returns a function that removes it again. */
export function registerCredentialProbe(probe: CredentialProbe): Unregister {
  credentialProbes.push(probe);
  return () => {
    const at = credentialProbes.indexOf(probe);
    if (at >= 0) credentialProbes.splice(at, 1);
  };
}

/** True when a registered probe says a token entry is present. The core never decides this itself. */
export function credentialReported(store: StoreLayout): boolean {
  return credentialProbes.some((probe) => probe.hasTokenCache(store) === true);
}

/**
 * Read one JSON file whole. This is the app's settings file, which does not hold
 * the sign-in token. `config.json` does, and is not read through here.
 */
function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** The app's settings object, when the file holds one. */
function preferencesIn(
  parsed: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const preferences = parsed?.preferences;
  return preferences && typeof preferences === 'object' && !Array.isArray(preferences)
    ? (preferences as Record<string, unknown>)
    : undefined;
}

export function readConfig(store: StoreLayout): StoreConfig {
  // Two files, read independently: a store can have one and not the other, and
  // the tray preference lives in the second — refusing to look at it because the
  // first is missing would be the same class of mistake this reader just made.
  // The first file also holds the sign-in token, so it is not parsed: only the
  // plain settings named below are copied out, and everything else is skipped.
  const settings = readJson(store.desktopConfigFile);
  const plain = readPlainConfig(store.configFile);

  const out: StoreConfig = {};
  if (plain.lastKnownAccountUuid !== undefined)
    out.lastKnownAccountUuid = plain.lastKnownAccountUuid;
  if (plain.locale !== undefined) out.locale = plain.locale;
  if (plain.updaterLastSeenVersion !== undefined) {
    out.updaterLastSeenVersion = plain.updaterLastSeenVersion;
  }
  // The app's own settings file first, then the two older readings of this one.
  const tray =
    preferencesIn(settings)?.menuBarEnabled ?? plain.preferencesMenuBar ?? plain.menuBarEnabled;
  if (typeof tray === 'boolean') out.menuBarEnabled = tray;
  return out;
}

interface PlainConfig {
  lastKnownAccountUuid?: string;
  locale?: string;
  updaterLastSeenVersion?: string;
  menuBarEnabled?: boolean;
  preferencesMenuBar?: boolean;
}

/** Copies the plain settings out of `config.json`. A missing or unreadable file is empty. */
function readPlainConfig(file: string): PlainConfig {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  try {
    return pickPlainSettings(text);
  } catch {
    return {};
  }
}

/**
 * One pass over a JSON object. Values of keys this reader does not want are
 * skipped, and a skipped string is never copied into a value of its own.
 * Anything the pass cannot follow — not an object, a broken value — throws,
 * and the caller treats that as an empty reading.
 */
function pickPlainSettings(text: string): PlainConfig {
  const scan = new JsonScan(text);
  const out: PlainConfig = {};
  scan.ws();
  scan.object((key) => {
    if ((READABLE_KEYS as readonly string[]).includes(key)) {
      scan.ws();
      if (scan.peek() !== '"') {
        scan.skip();
        return;
      }
      const value = scan.string(true);
      if (key === 'lastKnownAccountUuid') out.lastKnownAccountUuid = value;
      else if (key === 'locale') out.locale = value;
      else out.updaterLastSeenVersion = value;
      return;
    }
    if (key === 'menuBarEnabled') {
      const value = scan.takeBool();
      if (value !== undefined) out.menuBarEnabled = value;
      return;
    }
    if (key === 'preferences') {
      scan.ws();
      if (scan.peek() !== '{') {
        scan.skip();
        return;
      }
      scan.object((inner) => {
        if (inner !== 'menuBarEnabled') {
          scan.skip();
          return;
        }
        const value = scan.takeBool();
        if (value !== undefined) out.preferencesMenuBar = value;
      });
      return;
    }
    scan.skip();
  });
  scan.ws();
  scan.end();
  return out;
}

/** Thrown by {@link JsonScan} and swallowed by {@link readPlainConfig}. Never carries file text. */
class ScanError extends Error {}

/** A cursor over one JSON text. It copies a string only when asked to keep it. */
class JsonScan {
  private i = 0;

  constructor(private readonly s: string) {}

  peek(): string {
    return this.s[this.i] ?? '';
  }

  ws(): void {
    while (this.i < this.s.length && this.s.charCodeAt(this.i) <= 32) this.i++;
  }

  end(): void {
    if (this.i !== this.s.length) throw new ScanError('trailing');
  }

  object(onValue: (key: string) => void, keepKeys = true): void {
    if (this.peek() !== '{') throw new ScanError('object');
    this.i++;
    this.ws();
    if (this.peek() === '}') {
      this.i++;
      return;
    }
    for (;;) {
      this.ws();
      // A skipped object does not need its keys either: they can be as sensitive
      // as the values, and nothing is done with them.
      const key = this.string(keepKeys);
      this.ws();
      if (this.peek() !== ':') throw new ScanError('colon');
      this.i++;
      onValue(key);
      this.ws();
      const next = this.peek();
      if (next === ',') {
        this.i++;
        continue;
      }
      if (next === '}') {
        this.i++;
        return;
      }
      throw new ScanError('comma');
    }
  }

  /**
   * A boolean at the cursor, or undefined when the value is something else —
   * which is then skipped, so the caller has nothing left to consume.
   */
  takeBool(): boolean | undefined {
    this.ws();
    const word = this.s.startsWith('true', this.i)
      ? 'true'
      : this.s.startsWith('false', this.i)
        ? 'false'
        : undefined;
    if (word === undefined) {
      this.skip();
      return undefined;
    }
    const after = this.i + word.length;
    const next = this.s[after] ?? '';
    if (next !== '' && next !== ',' && next !== '}' && next !== ']' && next > ' ') {
      this.skip();
      return undefined;
    }
    this.i = after;
    return word === 'true';
  }

  /** Advance past one JSON value. String contents are not copied. */
  skip(): void {
    this.ws();
    const c = this.peek();
    if (c === '"') {
      this.string(false);
      return;
    }
    if (c === '{') {
      this.object(() => this.skip(), false);
      return;
    }
    if (c === '[') {
      this.array();
      return;
    }
    if (this.s.startsWith('true', this.i)) {
      this.i += 4;
      return;
    }
    if (this.s.startsWith('false', this.i)) {
      this.i += 5;
      return;
    }
    if (this.s.startsWith('null', this.i)) {
      this.i += 4;
      return;
    }
    this.skipNumber();
  }

  /**
   * Advance past one JSON number, in place. No slice of the tail: the value
   * after the number may be credential material, and it must not be copied
   * just to see where the number ends.
   */
  private skipNumber(): void {
    const start = this.i;
    if (this.s[this.i] === '-') this.i++;
    const digits = (): boolean => {
      const from = this.i;
      while (this.i < this.s.length) {
        const code = this.s.charCodeAt(this.i);
        if (code < 48 || code > 57) break;
        this.i++;
      }
      return this.i > from;
    };
    if (!digits()) throw new ScanError('number');
    const first = this.s[start] === '-' ? this.s[start + 1] : this.s[start];
    if (first === '0' && this.i > start + (this.s[start] === '-' ? 2 : 1)) {
      throw new ScanError('number');
    }
    if (this.s[this.i] === '.') {
      this.i++;
      if (!digits()) throw new ScanError('number');
    }
    if (this.s[this.i] === 'e' || this.s[this.i] === 'E') {
      this.i++;
      if (this.s[this.i] === '+' || this.s[this.i] === '-') this.i++;
      if (!digits()) throw new ScanError('number');
    }
  }

  /**
   * Read a JSON string starting at the cursor. `keep` false still walks the
   * escapes, so a quote inside the value cannot end it early, but the
   * characters are not stored.
   */
  string(keep: boolean): string {
    if (this.peek() !== '"') throw new ScanError('string');
    this.i++;
    let out = '';
    while (this.i < this.s.length) {
      const c = this.s[this.i]!;
      if (c === '"') {
        this.i++;
        return out;
      }
      if (c === '\\') {
        const escaped = this.s[this.i + 1];
        if (escaped === undefined) throw new ScanError('escape');
        this.i += 2;
        if (escaped === 'u') {
          const hex = this.s.slice(this.i, this.i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new ScanError('hex');
          this.i += 4;
          if (keep) out += String.fromCharCode(Number.parseInt(hex, 16));
          continue;
        }
        if (!keep) continue;
        const decoded = ESCAPES[escaped];
        if (decoded === undefined) throw new ScanError('escape');
        out += decoded;
        continue;
      }
      if (c.charCodeAt(0) < 0x20) throw new ScanError('control');
      if (keep) out += c;
      this.i++;
    }
    throw new ScanError('unterminated');
  }

  private array(): void {
    if (this.peek() !== '[') throw new ScanError('array');
    this.i++;
    this.ws();
    if (this.peek() === ']') {
      this.i++;
      return;
    }
    for (;;) {
      this.skip();
      this.ws();
      const next = this.peek();
      if (next === ',') {
        this.i++;
        continue;
      }
      if (next === ']') {
        this.i++;
        return;
      }
      throw new ScanError('comma');
    }
  }
}

const ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/**
 * Whether asking the main window to close will actually end the app.
 *
 * The window's close handler quits only when the tray is disabled; with the tray
 * on it cancels the close and hides the window instead. The setting is absent by
 * default, and absent means on — so for almost everyone, politely asking the
 * window to close hides it and changes nothing else.
 */
export function closingWindowQuits(store: StoreLayout): boolean {
  return readConfig(store).menuBarEnabled === false;
}
