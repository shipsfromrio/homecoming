import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { appendSynced } from '../util/fsatomic.js';
import { VERSION } from '../version.js';
import type { LedgerEvent, LedgerEventInput } from './types.js';
import { fosterHome } from '../util/home.js';

/**
 * The kinds this build folds. Everything else on a line with a string `kind`
 * is still history (written by a newer build, or by a plugin) and is kept as a
 * {@link ForeignLedgerEvent} rather than dropped.
 */
export const CORE_EVENT_KINDS: ReadonlySet<string> = new Set<string>([
  'account_labelled',
  'fostered',
  'returned',
  'fostering_followed',
  'card_repointed',
  'card_retitled',
  'card_dated',
  'conversation_purged',
  'failed',
  'worktree_released',
  'worktree_release_undone',
  'layout_applied',
  'pin_move_deferred',
  'pins_moved',
  'archive_synced',
  'pins_synced',
  'pins_clear_deferred',
  'pins_cleared',
  'layout_assigned',
  'view_carried',
  'view_seen',
]);

/**
 * A ledger line of a kind this build does not fold.
 *
 * The ledger is shared by every build that has ever written to it, so a line
 * this one does not understand is somebody else's state, not noise. It is
 * parsed, kept and handed to whichever registered reducer claims its kind;
 * `project()` never sees it. Nothing here rewrites the file, so keeping it
 * costs nothing, and dropping it would only matter to a writer, which this
 * append-only log does not have.
 */
export interface ForeignLedgerEvent {
  kind: string;
  v?: number;
  ts?: number;
  toolVersion?: string;
  [field: string]: unknown;
}

/** Any event line: one this build folds, or one it only carries. */
export type LedgerRecord = LedgerEvent | ForeignLedgerEvent;

export function isCoreEvent(record: LedgerRecord): record is LedgerEvent {
  return CORE_EVENT_KINDS.has(record.kind);
}

/**
 * A ledger line is an event when it is a JSON object with a string `kind`.
 * Valid JSON without that discriminant is a neighbor, not history: skip it,
 * keep the rest. A kind this build does not fold is preserved as-is.
 */
export function parseLedgerEvent(raw: string): LedgerRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.kind !== 'string' || record.kind.length === 0) return undefined;
  return record as unknown as LedgerRecord;
}

export function defaultLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(fosterHome(env), 'ledger.jsonl');
}

function statSyncOrUndefined(file: string): { size: number; mtimeMs: number } | undefined {
  try {
    return statSync(file);
  } catch {
    return undefined;
  }
}

/** What `read()` last parsed, and the stat that says whether it is still current. */
interface ReadCache {
  events: LedgerEvent[];
  records: LedgerRecord[];
  size: number;
  mtimeMs: number;
}

/**
 * Append-only event log. Kept outside the Claude Desktop store so that homecoming's
 * own bookkeeping can never be mistaken for app data.
 */
export class Ledger {
  private directoryEnsured = false;

  /**
   * The last parse, kept alive across calls on one instance.
   *
   * Measured on a real ledger (23 MB, 30,445 events): reading and parsing it
   * costs 160-190 ms, and a single sweep calls `read()` on the order of a dozen
   * times per round across up to three rounds, plus once per copy in the branch
   * pass — several seconds paid over and over for the same bytes. Keyed on
   * `(size, mtimeMs)` rather than trusted blindly, so a ledger changed from
   * outside this instance (another `homecoming` process, a hand edit) is still
   * caught and re-read — the same guarantee an uncached `readFileSync` gave.
   */
  private cache?: ReadCache;

  constructor(private readonly file: string = defaultLedgerPath()) {}

  get path(): string {
    return this.file;
  }

  /**
   * Records an operation that has already completed.
   *
   * Deliberately after the filesystem work, not before. A record of something
   * that did not happen cannot be detected later: a "fostered" event with no file
   * makes every future run skip that session as already done, and a "returned"
   * event with the copy still on disk orphans it where nothing will look again.
   * The opposite gap is self-healing — a copy written but not recorded still
   * carries its own _foster marker for the scanner to find, and a copy deleted
   * but not recorded is simply removed again, which succeeds.
   */
  append(event: LedgerEventInput): LedgerEvent {
    const full = {
      v: 1 as const,
      ts: event.ts ?? Date.now(),
      toolVersion: VERSION,
      ...event,
    } as LedgerEvent;

    // Once per instance rather than once per event: a batch appends one event per
    // session, and the directory cannot stop existing midway through.
    if (!this.directoryEnsured) {
      mkdirSync(path.dirname(this.file), { recursive: true });
      this.directoryEnsured = true;
      // Only worth checking the first time: nothing but this instance's own
      // appends can leave the file torn again once it is fixed here, so paying
      // the open-and-seek on every later append would guard against a condition
      // that stops recurring after the first one is caught.
      this.ensureTrailingNewline();
    }
    // Taken *before* the write, so it describes the file this instance's cache
    // actually claims to represent. A second writer — another `homecoming`
    // process, a hand edit, a detached restart script, all of which this
    // ledger is meant to tolerate (see the class docstring) — can append
    // between this instance's last read()/append() and this call; if it did,
    // this stat will already disagree with `this.cache`, and pushing `full`
    // onto the cached array below would silently drop that other writer's
    // event forever (the post-write stat would then make the cache match the
    // real file exactly, so no future read() would ever re-fetch it).
    const preStat = this.cache ? statSyncOrUndefined(this.file) : undefined;

    // fsynced rather than a plain appendFileSync: a crash right after this
    // call returns must not leave the event sitting in cache, unflushed, with
    // the caller believing it durable (see `appendSynced`'s own docstring —
    // the same "torn tail is recoverable, missing bytes are not" reasoning
    // `ensureTrailingNewline` above already assumes when it repairs one).
    appendSynced(this.file, Buffer.from(`${JSON.stringify(full)}\n`, 'utf8'));

    // Kept in step with the write rather than dropped: growing the cached array
    // in place is what lets `read()` skip the reparse on the very next call, and
    // what lets `project()` (ledger/project.ts) memoize its fold over the same
    // array reference. A cache miss here would cost exactly the reparse this
    // whole thing exists to avoid — worse, on every write in a batch that both
    // reads and writes the ledger many times over (a sweep round).
    if (this.cache) {
      const staleBeforeWrite =
        !preStat || preStat.size !== this.cache.size || preStat.mtimeMs !== this.cache.mtimeMs;
      if (staleBeforeWrite) {
        // Someone else wrote to this file since this instance last saw it.
        // The in-memory array is missing whatever they added, so pushing
        // `full` onto it would produce a view with this instance's own event
        // but not theirs — worse than no cache at all. Drop it; the next
        // read() reparses from disk and picks up everything.
        this.cache = undefined;
      } else {
        this.cache.events.push(full);
        this.cache.records.push(full);
        const stat = statSyncOrUndefined(this.file);
        if (stat) {
          this.cache.size = stat.size;
          this.cache.mtimeMs = stat.mtimeMs;
        } else {
          // Cannot happen right after a successful append, but if the file
          // somehow is not there to stat, dropping the cache is the safe
          // fallback: the next read() just reparses, same as an instance that
          // never cached anything.
          this.cache = undefined;
        }
      }
    }
    return full;
  }

  /**
   * Guarantees the file this instance is about to append to already ends in a
   * newline, before the very first append of this instance's life.
   *
   * `appendFileSync` does not check. A line left torn on disk — the detached
   * restart's `taskkill /F`, a power loss mid-write — glues to whatever is
   * appended next: the two half-lines together are neither valid JSON nor
   * separated by a line break, so `parseLedgerEvent` fails on the merged line
   * and *both* events are lost, not just the one that was already damaged.
   * Fixed here rather than left to `read()`'s existing tolerance for a torn
   * *trailing* line (see `parseLedgerEvent`'s skip-what-does-not-parse
   * behaviour, exercised by the "survives a torn final line" test) — that
   * tolerance only helps a reader that never writes again; this instance is
   * about to.
   */
  private ensureTrailingNewline(): void {
    let fd: number;
    try {
      fd = openSync(this.file, 'r+');
    } catch {
      // No file yet — appendFileSync below creates one, newline-clean by
      // construction.
      return;
    }
    try {
      const size = fstatSync(fd).size;
      if (size === 0) return;
      const lastByte = Buffer.alloc(1);
      readSync(fd, lastByte, 0, 1, size - 1);
      if (lastByte[0] !== 0x0a) {
        writeSync(fd, Buffer.from('\n', 'utf8'), 0, 1, size);
      }
    } finally {
      closeSync(fd);
    }
  }

  /**
   * The events on disk, parsed.
   *
   * Handed to callers as the live cached array, never a copy: iterating it is
   * every caller's whole use of it (checked across `src/`; nothing sorts,
   * pushes or otherwise mutates what this returns), so a defensive copy here
   * would spend on every call exactly the time this cache exists to save.
   * `project()` leans on that identity to memoize its own fold — see
   * `ledger/project.ts`.
   */
  read(): LedgerEvent[] {
    let stat: { size: number; mtimeMs: number };
    try {
      stat = statSync(this.file);
    } catch (error) {
      // ENOENT is the only "no events" case: no file (yet, or any more). A
      // ledger is never deleted out from under a live instance in ordinary
      // use, so this is almost always "yet" — the honest answer is empty, not
      // a stale cache from before. Anything else — EISDIR because the path
      // was replaced by a directory, EACCES, ... — is a real problem the
      // caller must not silently read as "nothing has ever happened here."
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`could not read ledger at ${this.file}: ${(error as Error).message}`, {
          cause: error,
        });
      }
      this.cache = undefined;
      return [];
    }

    if (this.cache && this.cache.size === stat.size && this.cache.mtimeMs === stat.mtimeMs) {
      return this.cache.events;
    }

    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(`could not read ledger at ${this.file}: ${(error as Error).message}`, {
        cause: error,
      });
    }

    const events: LedgerEvent[] = [];
    const records: LedgerRecord[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const record = parseLedgerEvent(trimmed);
      if (!record) continue;
      records.push(record);
      if (isCoreEvent(record)) events.push(record);
    }
    this.cache = { events, records, size: stat.size, mtimeMs: stat.mtimeMs };
    return events;
  }

  /**
   * Every event on disk, including the kinds this build does not fold (see
   * {@link ForeignLedgerEvent}). Same caching and the same live-array contract
   * as {@link read}.
   */
  readRecords(): LedgerRecord[] {
    this.read();
    return this.cache?.records ?? [];
  }

  /**
   * Records an event of a kind the core does not fold, for a plugin's own
   * reducer to read back. A core kind is refused: those go through
   * {@link append}, whose input type is what keeps their fields honest.
   */
  appendRecord(event: { kind: string; ts?: number } & Record<string, unknown>): ForeignLedgerEvent {
    if (CORE_EVENT_KINDS.has(event.kind)) {
      throw new Error(`"${event.kind}" is a core event kind; use append()`);
    }
    return this.append(event as unknown as LedgerEventInput) as unknown as ForeignLedgerEvent;
  }
}
