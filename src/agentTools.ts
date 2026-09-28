import type { StoreLayout } from './domain/types.js';
import type { Unregister } from './extensions.js';
import type { Ledger } from './ledger/log.js';

/**
 * A tool a plugin offers to an agent host that embeds homecoming. The core has
 * no agent and never calls one: this is only a registry, so a host can list
 * what the loaded plugins provide and describe each tool with its own schema.
 */
export interface AgentTool {
  /** Unique across registered tools; a second tool with a taken name is refused. */
  name: string;
  description: string;
  /** JSON Schema of `input`, handed to the host as is. */
  inputSchema: Readonly<Record<string, unknown>>;
  run(input: unknown, context: { store: StoreLayout; ledger: Ledger }): Promise<unknown>;
}

const agentTools: AgentTool[] = [];

/** Adds a tool. A name another registered tool already has is refused with an error. */
export function registerAgentTool(tool: AgentTool): Unregister {
  if (!tool.name || agentTools.some((entry) => entry.name === tool.name)) {
    throw new Error(
      tool.name ? `agent tool "${tool.name}" is already registered` : 'agent tool needs a name',
    );
  }
  agentTools.push(tool);
  return () => {
    const at = agentTools.indexOf(tool);
    if (at >= 0) agentTools.splice(at, 1);
  };
}

export function listAgentTools(): readonly AgentTool[] {
  return agentTools;
}
