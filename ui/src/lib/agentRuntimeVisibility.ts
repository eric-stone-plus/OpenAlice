import type { AgentInfo } from '../components/workspace/api'

/**
 * The desktop build offers opencode as its only agent runtime. Utility
 * adapters (the shell) are not agent runtimes and stay available. The backend
 * keeps the other adapters for non-desktop clients; the visibility boundary
 * lives in the UI so session metadata and utility entries are not lost.
 */
export const VISIBLE_AGENT_RUNTIME_IDS = ['opencode'] as const

export function isAgentRuntimeVisible(agent: Pick<AgentInfo, 'id' | 'kind'>): boolean {
  return agent.kind === 'utility' || (VISIBLE_AGENT_RUNTIME_IDS as readonly string[]).includes(agent.id)
}

export function visibleAgentRuntimes<T extends Pick<AgentInfo, 'id' | 'kind'>>(agents: readonly T[]): T[] {
  return agents.filter(isAgentRuntimeVisible)
}
