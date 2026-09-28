import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeStats,
  registerStatsCounter,
  registerStatsDimension,
  statsBucketName,
  statsDimensionNames,
  usageEventsInFile,
  type StatsConversation,
  type StatsDeps,
  type UsageEvent,
} from '../src/engine/stats.js';

/**
 * Stats dimensions and counters: a plugin groups `stats` by something the core
 * does not know (here, the account a conversation belongs to) and counts
 * something beside the tokens. Without either, reports are what they were.
 */

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

let undo: (() => void)[] = [];
afterEach(() => {
  for (const step of undo.reverse()) step();
  undo = [];
});

function event(tokens: number, counters?: Record<string, number>): UsageEvent {
  return {
    at: NOW,
    model: 'claude-sonnet-5',
    inputTokens: tokens,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    ...(counters ? { counters } : {}),
  };
}

function deps(conversations: StatsConversation[], events: Record<string, UsageEvent[]>): StatsDeps {
  return {
    conversations: () => conversations,
    eventsOf: (id, since) => (events[id] ?? []).filter((e) => e.at >= since),
  };
}

describe('stats dimensions', () => {
  it('group by the key the plugin gives, and a conversation with none goes to (unknown)', () => {
    undo.push(
      registerStatsDimension({
        name: 'account',
        label: 'account',
        keyOf: (conversation) => conversation.accountUuid,
      }),
    );

    const report = computeStats(
      { since: NOW - 1, by: 'account' },
      deps(
        [
          { cliSessionId: 'one', accountUuid: A },
          { cliSessionId: 'two', accountUuid: A },
          { cliSessionId: 'three', accountUuid: B },
          { cliSessionId: 'four' },
        ],
        { one: [event(10)], two: [event(5)], three: [event(7)], four: [event(1)] },
      ),
    );

    expect(report.by).toBe('account');
    expect(report.buckets.map((b) => [b.key.extra?.account, b.sessions, b.inputTokens])).toEqual([
      [A, 2, 15],
      [B, 1, 7],
      ['(unknown)', 1, 1],
    ]);
    expect(report.buckets.map((b) => statsBucketName('account', b))).toEqual([A, B, '(unknown)']);
    expect(report.totals.inputTokens).toBe(23);
  });

  it('are listed after the core ones, and taken away again', () => {
    expect(statsDimensionNames()).toEqual(['model', 'week']);
    const off = registerStatsDimension({ name: 'account', keyOf: () => undefined });
    expect(statsDimensionNames()).toEqual(['model', 'week', 'account']);
    off();
    expect(statsDimensionNames()).toEqual(['model', 'week']);
    expect(() => computeStats({ since: 0, by: 'account' }, deps([], {}))).toThrow(/account/);
  });

  it('cannot take a name already in use', () => {
    expect(() => registerStatsDimension({ name: 'model', keyOf: () => 'x' })).toThrow(/model/);
  });
});

describe('stats counters', () => {
  it('sum per bucket and in the total, each event counted once', () => {
    const report = computeStats(
      { since: NOW - 1, by: 'model' },
      deps([{ cliSessionId: 'a' }, { cliSessionId: 'b' }], {
        a: [event(1, { calls: 2 }), event(1, { calls: 3 })],
        b: [event(1, { calls: 4 })],
      }),
    );

    expect(report.buckets[0]?.counters).toEqual({ calls: 9 });
    // Summing the event into the bucket and again into the total (or twice into
    // either) would show 18 somewhere.
    expect(report.totals.counters).toEqual({ calls: 9 });
  });

  it('are read from each usage record in a transcript', () => {
    undo.push(
      registerStatsCounter({
        name: 'blocks',
        count: (record) => {
          const content = (record.message as { content?: unknown[] } | undefined)?.content;
          return Array.isArray(content) ? content.length : 0;
        },
      }),
    );
    undo.push(
      registerStatsCounter({
        name: 'broken',
        count: () => {
          throw new Error('broken');
        },
      }),
    );
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'homecoming-stx-')), 't.jsonl');
    const line = (n: number) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(NOW).toISOString(),
        message: {
          model: 'claude-sonnet-5',
          content: Array.from({ length: n }, () => ({ type: 'text' })),
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
    writeFileSync(file, [line(2), line(3)].join('\n'), 'utf8');

    const events = usageEventsInFile(file, NOW - 1);
    expect(events.map((e) => e.counters)).toEqual([
      { blocks: 2, broken: 0 },
      { blocks: 3, broken: 0 },
    ]);
    const report = computeStats(
      { since: NOW - 1, by: 'week' },
      deps([{ cliSessionId: 'x' }], { x: events }),
    );
    expect(report.totals.counters).toEqual({ blocks: 5, broken: 0 });
  });

  it('leave events and reports without a counters field when none is registered', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'homecoming-stx-')), 't.jsonl');
    writeFileSync(
      file,
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(NOW).toISOString(),
        message: { model: 'm', usage: { input_tokens: 1 } },
      }),
      'utf8',
    );
    const [only] = usageEventsInFile(file, NOW - 1);
    expect(only).not.toHaveProperty('counters');

    const report = computeStats(
      { since: NOW - 1, by: 'model' },
      deps([{ cliSessionId: 'x' }], { x: [event(1)] }),
    );
    expect(report.buckets[0]).not.toHaveProperty('counters');
    expect(report.totals).not.toHaveProperty('counters');
  });
});
