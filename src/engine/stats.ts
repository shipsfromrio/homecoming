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
}

export interface StatsOptions {
  /** Only events at or after this instant. */
  since: number;
  by: 'model' | 'week';
}

/** One conversation to fold into the report. */
export interface StatsConversation {
  cliSessionId: string;
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
}

export interface StatsBucket {
  key: StatsBucketKey;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface StatsReport {
  since: number;
  by: StatsOptions['by'];
  buckets: StatsBucket[];
  totals: Omit<StatsBucket, 'key'>;
}

interface Cell {
  model: string;
  week: string;
  sessions: Set<string>;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

function cellFor(cells: Map<string, Cell>, model: string, week: string): Cell {
  const key = JSON.stringify([model, week]);
  let cell = cells.get(key);
  if (!cell) {
    cell = {
      model,
      week,
      sessions: new Set(),
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    };
    cells.set(key, cell);
  }
  return cell;
}

export function computeStats(options: StatsOptions, deps: StatsDeps): StatsReport {
  const cells = new Map<string, Cell>();
  const totalSessions = new Set<string>();
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };

  for (const conversation of deps.conversations()) {
    const usage = deps.eventsOf(conversation.cliSessionId, options.since);
    if (usage.length === 0) continue;
    totalSessions.add(conversation.cliSessionId);

    for (const event of usage) {
      const week = weekKey(event.at);
      const cell = cellFor(cells, event.model, week);
      cell.sessions.add(conversation.cliSessionId);
      cell.inputTokens += event.inputTokens;
      cell.outputTokens += event.outputTokens;
      cell.cacheCreationTokens += event.cacheCreationTokens;
      cell.cacheReadTokens += event.cacheReadTokens;
      totals.inputTokens += event.inputTokens;
      totals.outputTokens += event.outputTokens;
      totals.cacheCreationTokens += event.cacheCreationTokens;
      totals.cacheReadTokens += event.cacheReadTokens;
    }
  }

  return {
    since: options.since,
    by: options.by,
    buckets: collapse(cells, options.by),
    totals: { sessions: totalSessions.size, ...totals },
  };
}

/** Merges the fine-grained (model, week) cells down to the one dimension asked for. */
function collapse(cells: Map<string, Cell>, by: StatsOptions['by']): StatsBucket[] {
  const merged = new Map<
    string,
    { key: StatsBucketKey; sessions: Set<string> } & Omit<StatsBucket, 'key' | 'sessions'>
  >();

  for (const cell of cells.values()) {
    const key: StatsBucketKey = by === 'model' ? { model: cell.model } : { week: cell.week };
    const mapKey = by === 'model' ? cell.model : cell.week;

    let bucket = merged.get(mapKey);
    if (!bucket) {
      bucket = {
        key,
        sessions: new Set(),
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      };
      merged.set(mapKey, bucket);
    }
    for (const id of cell.sessions) bucket.sessions.add(id);
    bucket.inputTokens += cell.inputTokens;
    bucket.outputTokens += cell.outputTokens;
    bucket.cacheCreationTokens += cell.cacheCreationTokens;
    bucket.cacheReadTokens += cell.cacheReadTokens;
  }

  const buckets = [...merged.values()].map((bucket) => ({
    key: bucket.key,
    sessions: bucket.sessions.size,
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    cacheCreationTokens: bucket.cacheCreationTokens,
    cacheReadTokens: bucket.cacheReadTokens,
  }));

  if (by === 'week') buckets.sort((a, b) => (a.key.week ?? '').localeCompare(b.key.week ?? ''));
  else {
    buckets.sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
  }
  return buckets;
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
  return {
    at,
    model,
    inputTokens: numberField(usage.input_tokens),
    outputTokens: numberField(usage.output_tokens),
    cacheCreationTokens: numberField(usage.cache_creation_input_tokens),
    cacheReadTokens: numberField(usage.cache_read_input_tokens),
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
