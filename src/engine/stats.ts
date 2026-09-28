import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { indexAllTranscripts, transcriptRoots } from '../store/transcripts.js';

/**
 * `homecoming stats` — token usage and sessions, read out of the transcripts
 * themselves and aggregated per model or per week.
 *
 * A single total hides where the tokens actually went: one model or one week
 * can carry most of it. Nothing here goes to the network — this reads what the
 * transcripts on this machine already wrote down.
 */

export interface UsageEvent {
  at: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** What each registered stats counter counted on this record; absent without one. */
  counters?: Record<string, number>;
}

export interface StatsOptions {
  /** Only events at or after this instant. */
  since: number;
  /** `model`, `week`, or the name of a registered stats dimension. */
  by: string;
}

/** One conversation to fold into the report. */
export interface StatsConversation {
  cliSessionId: string;
  /** The account the conversation belongs to, when whoever listed it knows. */
  accountUuid?: string;
}

/** The seams tests replace: which conversations exist, and what their transcripts say. */
export interface StatsDeps {
  conversations(): StatsConversation[];
  /** Usage events at or after `since`, from every file the conversation occupies. */
  eventsOf(cliSessionId: string, since: number): UsageEvent[];
}

export interface StatsBucketKey {
  model?: string;
  /** The Monday (UTC) the week starts, as `YYYY-MM-DD`. */
  week?: string;
  /** For a registered dimension: its name and the key it gave, `(unknown)` for none. */
  extra?: Record<string, string>;
}

export interface StatsBucket {
  key: StatsBucketKey;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Registered counters, summed over the bucket's events; absent without one. */
  counters?: Record<string, number>;
}

export interface StatsReport {
  since: number;
  by: StatsOptions['by'];
  buckets: StatsBucket[];
  totals: Omit<StatsBucket, 'key'>;
}

// ---------------------------------------------------------------------------
// Extension points: further dimensions to group by, further things to count.
// ---------------------------------------------------------------------------

/** Removes what a `register*` call added. */
type Unregister = () => void;

/**
 * A further way to group `stats`, beside `model` and `week`. `keyOf` names the
 * bucket an event falls in; undefined puts it in the `(unknown)` bucket rather
 * than dropping it, so the totals never depend on the dimension chosen.
 */
export interface StatsDimension {
  name: string;
  /** How the report headline names the dimension; the name when absent. */
  label?: string;
  keyOf(conversation: StatsConversation, event: UsageEvent): string | undefined;
}

/**
 * Something more to count on each assistant record that carries usage, beside
 * the token fields. `count` sees the parsed record and returns how many of the
 * thing it holds; anything but a finite number counts as zero, and a counter
 * that throws counts zero for that record.
 */
export interface StatsCounter {
  name: string;
  count(record: Readonly<Record<string, unknown>>): number;
}

const CORE_DIMENSIONS = ['model', 'week'] as const;

/** The bucket a dimension gives nothing for. */
export const UNKNOWN_STATS_KEY = '(unknown)';

const dimensions: StatsDimension[] = [];
const counters: StatsCounter[] = [];

function addTo<T>(list: T[], item: T): Unregister {
  list.push(item);
  return () => {
    const at = list.indexOf(item);
    if (at >= 0) list.splice(at, 1);
  };
}

/** Adds a dimension `stats --by` can group on. A name already taken is refused. */
export function registerStatsDimension(dimension: StatsDimension): Unregister {
  if (statsDimensionNames().includes(dimension.name)) {
    throw new Error(`stats dimension "${dimension.name}" is already registered`);
  }
  return addTo(dimensions, dimension);
}

/** Adds a counter summed into every bucket and the totals. A name already taken is refused. */
export function registerStatsCounter(counter: StatsCounter): Unregister {
  if (counters.some((existing) => existing.name === counter.name)) {
    throw new Error(`stats counter "${counter.name}" is already registered`);
  }
  return addTo(counters, counter);
}

/** Every dimension `stats --by` accepts: the core's two, then the registered ones. */
export function statsDimensionNames(): string[] {
  return [...CORE_DIMENSIONS, ...dimensions.map((dimension) => dimension.name)];
}

/** What the report headline calls a dimension. */
export function statsDimensionLabel(by: string): string {
  return dimensions.find((dimension) => dimension.name === by)?.label ?? by;
}

/** The name one bucket goes by in a report grouped by `by`. */
export function statsBucketName(by: string, bucket: StatsBucket): string {
  if (by === 'model') return bucket.key.model ?? 'unknown';
  if (by === 'week') return bucket.key.week ?? '?';
  return bucket.key.extra?.[by] ?? UNKNOWN_STATS_KEY;
}

/** Each registered counter's count on one record, or undefined with none registered. */
function countersOf(record: Readonly<Record<string, unknown>>): Record<string, number> | undefined {
  if (counters.length === 0) return undefined;
  const out: Record<string, number> = {};
  for (const counter of counters) {
    let value = 0;
    try {
      const counted = counter.count(record);
      value = typeof counted === 'number' && Number.isFinite(counted) ? counted : 0;
    } catch {
      value = 0;
    }
    out[counter.name] = value;
  }
  return out;
}

interface Tally {
  key: StatsBucketKey;
  sessions: Set<string>;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  counters?: Record<string, number>;
}

function emptyTally(key: StatsBucketKey): Tally {
  return {
    key,
    sessions: new Set(),
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
}

/** Adds one event to a tally, counters included, exactly once. */
function add(tally: Tally, sessionId: string, event: UsageEvent): void {
  tally.sessions.add(sessionId);
  tally.inputTokens += event.inputTokens;
  tally.outputTokens += event.outputTokens;
  tally.cacheCreationTokens += event.cacheCreationTokens;
  tally.cacheReadTokens += event.cacheReadTokens;
  if (event.counters) {
    tally.counters ??= {};
    for (const [name, value] of Object.entries(event.counters)) {
      tally.counters[name] = (tally.counters[name] ?? 0) + value;
    }
  }
}

function settle(tally: Tally): Omit<StatsBucket, 'key'> {
  return {
    sessions: tally.sessions.size,
    inputTokens: tally.inputTokens,
    outputTokens: tally.outputTokens,
    cacheCreationTokens: tally.cacheCreationTokens,
    cacheReadTokens: tally.cacheReadTokens,
    ...(tally.counters ? { counters: tally.counters } : {}),
  };
}

/** The bucket one event falls in, as a map key and as the report's key. */
function bucketOf(
  by: string,
  dimension: StatsDimension | undefined,
  conversation: StatsConversation,
  event: UsageEvent,
): { id: string; key: StatsBucketKey } {
  if (by === 'model') return { id: event.model, key: { model: event.model } };
  if (by === 'week') {
    const week = weekKey(event.at);
    return { id: week, key: { week } };
  }
  let found: string | undefined;
  try {
    found = dimension?.keyOf(conversation, event);
  } catch {
    found = undefined;
  }
  const value = typeof found === 'string' && found !== '' ? found : UNKNOWN_STATS_KEY;
  return { id: value, key: { extra: { [by]: value } } };
}

export function computeStats(options: StatsOptions, deps: StatsDeps): StatsReport {
  const dimension = dimensions.find((candidate) => candidate.name === options.by);
  if (!dimension && !(CORE_DIMENSIONS as readonly string[]).includes(options.by)) {
    throw new Error(
      `Cannot group stats by "${options.by}". Choose one of: ${statsDimensionNames().join(', ')}.`,
    );
  }

  const buckets = new Map<string, Tally>();
  const totals = emptyTally({});

  for (const conversation of deps.conversations()) {
    const usage = deps.eventsOf(conversation.cliSessionId, options.since);
    if (usage.length === 0) continue;
    totals.sessions.add(conversation.cliSessionId);

    for (const event of usage) {
      const { id, key } = bucketOf(options.by, dimension, conversation, event);
      let bucket = buckets.get(id);
      if (!bucket) {
        bucket = emptyTally(key);
        buckets.set(id, bucket);
      }
      add(bucket, conversation.cliSessionId, event);
      add(totals, conversation.cliSessionId, event);
    }
  }

  const rows: StatsBucket[] = [...buckets.values()].map((tally) => ({
    key: tally.key,
    ...settle(tally),
  }));
  if (options.by === 'week')
    rows.sort((a, b) => (a.key.week ?? '').localeCompare(b.key.week ?? ''));
  else rows.sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));

  return {
    since: options.since,
    by: options.by,
    buckets: rows,
    totals: settle(totals),
  };
}

/** The Monday (UTC) a moment's week starts on, as `YYYY-MM-DD` — stable across timezones. */
export function weekKey(at: number): string {
  const d = new Date(at);
  const isoDay = (d.getUTCDay() + 6) % 7; // 0 = Monday, ... 6 = Sunday
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - isoDay));
  return monday.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Real deps: transcripts on disk.
// ---------------------------------------------------------------------------

/** How much of a transcript to hold in memory at once while scanning it. */
const CHUNK_BYTES = 1024 * 1024;

function* streamLines(file: string): Generator<string> {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return;
  }
  try {
    const buffer = Buffer.alloc(CHUNK_BYTES);
    let pending = '';
    for (;;) {
      const read = readSync(fd, buffer, 0, CHUNK_BYTES, null);
      if (read === 0) break;
      const lines = (pending + buffer.subarray(0, read).toString('utf8')).split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) yield line;
    }
    if (pending !== '') yield pending;
  } catch {
    // A transcript that turns unreadable mid-scan yields what it gave; the
    // caller treats a short read as "no more events" rather than as a fork.
  } finally {
    closeSync(fd);
  }
}

function numberField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * One line's usage event, or undefined for a line that is not an assistant
 * record carrying `usage`.
 *
 * A cheap substring check comes before `JSON.parse`, on purpose: the large
 * majority of lines in a transcript are tool calls and tool results, and a
 * turn's `usage` appears on one assistant record. Measured against the whole-record parse this replaces on a real
 * store's transcripts (`recordFields` in `store/transcripts.ts` did the same
 * measurement for a different pair of fields): skipping the parse for every
 * line that cannot possibly match is the entire saving, not a rounding error.
 */
function eventOfLine(line: string): UsageEvent | undefined {
  if (!line.includes('"usage"')) return undefined;

  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (record.type !== 'assistant' || record.isSidechain === true) return undefined;

  const at = Date.parse(typeof record.timestamp === 'string' ? record.timestamp : '');
  if (!Number.isFinite(at)) return undefined;

  const message = record.message as Record<string, unknown> | undefined;
  const model = typeof message?.model === 'string' ? message.model : 'unknown';

  // An error record the app writes in the model's place carries no real turn.
  if (record.isApiErrorMessage === true) return undefined;

  const usage = message?.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== 'object') return undefined;
  const counted = countersOf(record);
  return {
    at,
    model,
    inputTokens: numberField(usage.input_tokens),
    outputTokens: numberField(usage.output_tokens),
    cacheCreationTokens: numberField(usage.cache_creation_input_tokens),
    cacheReadTokens: numberField(usage.cache_read_input_tokens),
    ...(counted ? { counters: counted } : {}),
  };
}

/** Every usage event in one transcript file, at or after `since`. */
export function usageEventsInFile(file: string, since: number): UsageEvent[] {
  const usage: UsageEvent[] = [];
  for (const line of streamLines(file)) {
    const found = eventOfLine(line);
    if (found && found.at >= since) usage.push(found);
  }
  return usage;
}

/** Every conversation whose transcript this machine holds, read from disk. */
export function defaultStatsDeps(env: NodeJS.ProcessEnv = process.env): StatsDeps {
  const index = indexAllTranscripts(transcriptRoots(env));
  const conversations: StatsConversation[] = [...index.keys()].map((cliSessionId) => ({
    cliSessionId,
  }));

  return {
    conversations: () => conversations,
    eventsOf(cliSessionId, since) {
      const files = index.get(cliSessionId) ?? [];
      const usage: UsageEvent[] = [];
      for (const file of files) {
        // A file whose last write predates the window cannot hold a record
        // inside it — records are appended in order — so the read itself,
        // the expensive part on a large transcript, is skipped outright.
        let mtime: number;
        try {
          mtime = statSync(file).mtimeMs;
        } catch {
          continue;
        }
        if (mtime < since) continue;
        usage.push(...usageEventsInFile(file, since));
      }
      return usage;
    },
  };
}
