export type Weekly = { percentUsed: number; resetsAt?: string }
export type AgentMeta = { startedAt: number; endedAt?: number; contextTokens: number; outputTokens: number }
export type ContextFill = { tokens?: number; window: number; percent?: number }
export type Bar = { baseline: number; current: number; resetsAt?: string }
export type Task = {
  id: string
  title: string
  type?: string
  status: string
  tail: string
  lines?: string
  isLive: boolean
  outputPath?: string
  command?: string
  startedAt?: number
  endedAt?: number
  /** Polls in a row that found no output file. */
  misses?: number
}
/** One row of an agent's console: a stretch of its text, or a tool call and the head of its result. */
export type ConsoleRow =
  | { kind: 'text'; text: string }
  | { kind: 'call'; id: string; tool: string; label: string; result?: string; more?: number; isError?: boolean }

declare module 'claude-code' {
  interface PluginState {
    'side-monitor': {
      baseline: Weekly | null
      bar: Bar | null
      barShownAt: number
      agents: Task[]
      shells: Task[]
      agentMeta: Record<string, AgentMeta>
      context: ContextFill | null
      expanded: string | null
      mode: string
      compactQueued: boolean
      consoles: Record<string, ConsoleRow[]>
    }
  }
}
