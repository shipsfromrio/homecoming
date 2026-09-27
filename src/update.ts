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

/**
 * The `owner/name` whose releases are checked and installed from. A fork (or a
 * private build) sets `HOMECOMING_UPDATE_REPO`; a value that is not shaped like
 * `owner/name` is ignored rather than spliced into a URL.
 */
export function updateRepo(env: NodeJS.ProcessEnv = process.env): string {
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

/** Under `FOSTER_HOME` like everything else the tool keeps (see `util/home.ts`). */
export function cacheFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(fosterHome(env), 'update-check.json');
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
  const {
    current = VERSION,
    file = cacheFile(env),
    now = Date.now(),
    force = false,
    fetchLatest = () => fetchLatestTag(repo),
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
    if (fetched === undefined) return undefined;
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
