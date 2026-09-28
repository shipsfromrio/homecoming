import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fosterHome } from './util/home.js';
import { VERSION } from './version.js';

/**
 * Tells the user when a newer release exists.
 *
 * The install URL pins a tag, which is what makes the checksum meaningful — but
 * it also means an install never learns about later releases on its own. This is
 * the counterweight.
 *
 * Deliberately unobtrusive: the result is cached for a day, the request is given
 * a short deadline, and any failure is silent. Being offline, behind a proxy or
 * rate-limited must never slow down or break a tool whose actual work is local.
 */

/** Where releases are published, unless `HOMECOMING_UPDATE_REPO` names another. */
export const DEFAULT_UPDATE_REPO = 'shipsfromrio/homecoming';

const REPO_SHAPE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** A release tag: `v1.2.3`, `1.2.3`, `v1.2.3-rc.1`. Anything else is not spliced into a command. */
const TAG_SHAPE = /^v?\d+(\.\d+)*(-[0-9A-Za-z.-]+)?$/;

/**
 * An install command a channel suggests, before it is printed for the user to
 * run: one line of plain printable text, of a sane length, naming the tag it
 * installs. Anything else is dropped for the core's command, the same way a
 * `repo` that is not `owner/name` is.
 */
const MAX_INSTALL_COMMAND = 400;
function plausibleInstallCommand(command: unknown, tag: string): command is string {
  if (typeof command !== 'string') return false;
  const trimmed = command.trim();
  return (
    trimmed !== '' &&
    trimmed.length <= MAX_INSTALL_COMMAND &&
    // Printable ASCII only: no newline to smuggle a second command onto the
    // line, no escape sequence to repaint the terminal around it.
    /^[ -~]+$/.test(trimmed) &&
    trimmed.includes(tag)
  );
}

/**
 * Where releases are checked for: a repository, and optionally a cache of its
 * own, a way to ask for the latest tag, and the command that installs one. At
 * most one is registered; the core registers none and checks the repository
 * `updateRepo` names.
 *
 * Every function here is called inside the check's "never throws" contract: a
 * `fetchLatest` that throws, or answers with something that is not a release
 * tag, is an unknown answer, and an `installCommand` that throws, returns
 * nothing, or returns something other than one printable line naming the tag
 * falls back to the core's command for the same tag and repository.
 */
export interface UpdateChannel {
  /** `owner/name`, or a function of the environment returning one. */
  repo: string | ((env: NodeJS.ProcessEnv) => string);
  /** Keeps this channel's answer in a cache file of its own. */
  cacheKey?: string;
  fetchLatest?(repo: string): Promise<string | undefined>;
  installCommand?(tag: string, repo: string): string;
}

let channel: UpdateChannel | undefined;

/**
 * Sets the update channel. Returns a function that removes it again. A second
 * channel while one is registered is refused: two plugins disagreeing about
 * where releases come from is not something to settle by registration order.
 */
export function registerUpdateChannel(next: UpdateChannel): () => void {
  if (channel !== undefined) {
    throw new Error('an update channel is already registered; only one can be.');
  }
  channel = next;
  return () => {
    if (channel === next) channel = undefined;
  };
}

/**
 * The `owner/name` whose releases are checked and installed from. A registered
 * channel names it first; otherwise a fork sets `HOMECOMING_UPDATE_REPO`. A value that is not shaped like `owner/name`, from
 * either, is ignored rather than spliced into a URL, and so is a channel whose
 * `repo` function throws.
 */
export function updateRepo(env: NodeJS.ProcessEnv = process.env): string {
  if (channel) {
    let named: string | undefined;
    try {
      named = typeof channel.repo === 'function' ? channel.repo(env) : channel.repo;
    } catch {
      named = undefined;
    }
    const trimmed = typeof named === 'string' ? named.trim() : '';
    if (REPO_SHAPE.test(trimmed)) return trimmed;
  }
  const override = env.HOMECOMING_UPDATE_REPO?.trim();
  return override && REPO_SHAPE.test(override) ? override : DEFAULT_UPDATE_REPO;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 2500;

export interface UpdateStatus {
  current: string;
  latest: string;
  outdated: boolean;
  /** Command that installs the newer release, with the tag already substituted. */
  command: string;
}

interface Cache {
  latest: string;
  checkedAt: number;
  /** Which repository the answer came from; absent in caches written before it was recorded. */
  repo?: string;
}

const CACHE_KEY_SHAPE = /^[A-Za-z0-9._-]+$/;

/**
 * Under `FOSTER_HOME` like everything else the tool keeps (see `util/home.ts`).
 * A channel with a `cacheKey` gets a file of its own, so switching channels
 * never reads another channel's answer; a key that would not make a plain file
 * name is ignored.
 */
export function cacheFile(env: NodeJS.ProcessEnv = process.env): string {
  const key = channel?.cacheKey;
  const name =
    key && CACHE_KEY_SHAPE.test(key) && !/^\.+$/.test(key)
      ? `update-check-${key}.json`
      : 'update-check.json';
  return path.join(fosterHome(env), name);
}

/** Opt out for air-gapped machines, CI, or anyone who simply prefers no network. */
export function updateChecksDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.FOSTER_NO_UPDATE_CHECK;
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

/**
 * Compares dotted numeric versions. Anything with a pre-release suffix is treated
 * as older than the same release without one, so a published 1.0.0-rc never
 * prompts someone already on 1.0.0.
 */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (value: string) => {
    const [core = '', pre] = value.replace(/^v/, '').split('-', 2);
    return {
      parts: core.split('.').map((part) => Number.parseInt(part, 10) || 0),
      hasPre: pre !== undefined,
    };
  };
  const a = parse(candidate);
  const b = parse(current);

  for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i += 1) {
    const left = a.parts[i] ?? 0;
    const right = b.parts[i] ?? 0;
    if (left !== right) return left > right;
  }
  return !a.hasPre && b.hasPre;
}

function readCache(file: string): Cache | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Cache;
    return typeof parsed?.latest === 'string' && typeof parsed?.checkedAt === 'number'
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function writeCache(file: string, cache: Cache): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(cache), 'utf8');
  } catch {
    // A cache that cannot be written only costs one extra request later.
  }
}

async function fetchLatestTag(repo: string): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `homecoming/${VERSION}` },
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { tag_name?: unknown };
    return typeof body.tag_name === 'string' ? body.tag_name : undefined;
  } catch {
    // Offline, blocked, rate-limited, malformed: none of it is worth a word.
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export function installCommandFor(tag: string, repo: string = updateRepo()): string {
  if (channel?.installCommand) {
    try {
      const command = channel.installCommand(tag, repo);
      if (plausibleInstallCommand(command, tag)) return command.trim();
    } catch {
      // Falls through to the core's command for the same tag and repository.
    }
  }
  return `irm https://raw.githubusercontent.com/${repo}/${tag}/install.ps1 | iex`;
}

export interface CheckOptions {
  current?: string;
  file?: string;
  env?: NodeJS.ProcessEnv;
  now?: number;
  /** Ignore a fresh cache entry. */
  force?: boolean;
  /** Defaults to `updateRepo(env)`. */
  repo?: string;
  fetchLatest?: () => Promise<string | undefined>;
}

/** Resolves to undefined whenever the answer is unknown — never throws. */
export async function checkForUpdate(
  options: CheckOptions = {},
): Promise<UpdateStatus | undefined> {
  const env = options.env ?? process.env;
  const repo = options.repo ?? updateRepo(env);
  const channelFetch = channel?.fetchLatest?.bind(channel);
  const {
    current = VERSION,
    file = cacheFile(env),
    now = Date.now(),
    force = false,
    fetchLatest = channelFetch ? () => channelFetch(repo) : () => fetchLatestTag(repo),
  } = options;

  if (updateChecksDisabled(env)) return undefined;

  const cached = readCache(file);
  // A cache written for another repository answers a different question.
  const sameRepo = cached !== undefined && (cached.repo ?? DEFAULT_UPDATE_REPO) === repo;
  let latest =
    !force && sameRepo && now - cached.checkedAt < CACHE_TTL_MS ? cached.latest : undefined;

  if (latest === undefined) {
    // Guarded here rather than only inside the default fetcher: the contract is
    // "never throws", and it must hold for whatever collaborator is supplied.
    let fetched: string | undefined;
    try {
      fetched = await fetchLatest();
    } catch {
      return undefined;
    }
    if (typeof fetched !== 'string' || !TAG_SHAPE.test(fetched)) return undefined;
    latest = fetched;
    writeCache(file, { latest, checkedAt: now, repo });
  }

  const bare = latest.replace(/^v/, '');
  return {
    current,
    latest: bare,
    outdated: isNewer(bare, current),
    command: installCommandFor(latest.startsWith('v') ? latest : `v${bare}`, repo),
  };
}
