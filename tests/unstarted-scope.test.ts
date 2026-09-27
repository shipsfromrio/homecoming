import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DiscoveredSession, StoreLayout } from '../src/domain/types.js';
import { extraUnstartedSessions, registerUnstartedSource } from '../src/engine/unstarted.js';
import { usePlugin } from '../src/plugin.js';

const store = {} as StoreLayout;
const session = { data: { sessionId: 'extra-1' } } as unknown as DiscoveredSession;

describe('unstarted scope', () => {
  it('adds no sessions unless a source is registered', () => {
    expect(extraUnstartedSessions(store)).toEqual([]);
  });

  it('adds the sessions of a registered source, and stops after unregistering', () => {
    const undo = registerUnstartedSource({ name: 'test', sessions: () => [session] });
    expect(extraUnstartedSessions(store)).toEqual([session]);
    undo();
    expect(extraUnstartedSessions(store)).toEqual([]);
  });

  it('is reachable from a plugin', () => {
    const undo = usePlugin({
      name: 'p',
      unstartedSources: [{ name: 's', sessions: () => [session] }],
    });
    expect(extraUnstartedSessions(store)).toEqual([session]);
    undo();
    expect(extraUnstartedSessions(store)).toEqual([]);
  });

  it('the command scans the account signed in, not the whole store', () => {
    const source = readFileSync(new URL('../src/cli/index.ts', import.meta.url), 'utf8');
    const start = source.indexOf(".command('unstarted')");
    const end = source.indexOf('function formatLifetime', start);
    const action = source.slice(start, end);
    expect(action).toContain('requireCurrentAccount(');
    expect(action).toContain('scanAccount(');
    expect(action).not.toContain('scanStore(');
  });
});
