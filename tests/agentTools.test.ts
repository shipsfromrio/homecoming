import { describe, expect, it } from 'vitest';
import { listAgentTools, registerAgentTool, type AgentTool } from '../src/agentTools.js';

function tool(name: string): AgentTool {
  return {
    name,
    description: 'says hello',
    inputSchema: { type: 'object' },
    run: () => Promise.resolve('hello'),
  };
}

describe('agent tools', () => {
  it('is empty without a plugin', () => {
    expect(listAgentTools()).toEqual([]);
  });

  it('registers, lists and unregisters', async () => {
    const hello = tool('hello');
    const off = registerAgentTool(hello);
    expect(listAgentTools()).toEqual([hello]);
    await expect(listAgentTools()[0]?.run({}, {} as never)).resolves.toBe('hello');
    off();
    expect(listAgentTools()).toEqual([]);
  });

  it('refuses a second tool with a taken name', () => {
    const off = registerAgentTool(tool('hello'));
    try {
      expect(() => registerAgentTool(tool('hello'))).toThrow(/already registered/);
      expect(listAgentTools()).toHaveLength(1);
    } finally {
      off();
    }
  });
});
