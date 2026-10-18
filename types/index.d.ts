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
  endedAt?: number
}

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
    }
  }
}
