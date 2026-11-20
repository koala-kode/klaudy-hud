export type PetMood = 'idle' | 'working' | 'happy' | 'upset'

export type PetState = {
  mood: PetMood
  moodUntil: number
  lastActivityAt: number
}

export type BtwEntry = {
  id: string
  question: string
  answer?: string
  isPending: boolean
  askedAt: number
}

export type ToolStat = { count: number; errors: number; totalMs: number }

export type RecentCall = {
  id: string
  tool: string
  detail: string
  startedAt: number
  ms?: number
  isError?: boolean
  isDone: boolean
}

export type FileTouch = {
  path: string
  count: number
  lastAt: number
}

export type ContextCategoryShare = { name: string; tokens: number }

export type McpLoadedTool = { label: string; wire: string }

export type QuotaWindow = { kind: string; percentUsed: number; resetsAt?: string }

export type ContextInfo = {
  tokens?: number
  window: number
  percent?: number
  costUsd: number
  categories: ContextCategoryShare[]
  skillsTotal: number
  skillsIncluded: number
  skillsTokens: number
  autoCompactThreshold?: number
  model: string
  mcpLoadedTools: number
  mcpLoaded: McpLoadedTool[]
  rateLimits?: QuotaWindow[]
  updatedAt: number
}

export type AgentSeen = {
  id: string
  type: string
  description: string
  status: string
  firstSeenAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'klaudy-hud': {
      pet: PetState
      entries: Shaped<BtwEntry[]>
      stats: Shaped<Record<string, ToolStat>>
      recent: Shaped<RecentCall[]>
      files: Shaped<Record<string, FileTouch>>
      agents: Shaped<Record<string, AgentSeen>>
      tick: Shaped<number>
      context: Shaped<ContextInfo | null>
      usedSkills: Shaped<string[]>
      agentModels: Shaped<Record<string, string>>
      agentUsage: Shaped<Record<string, number>>
      collapsed: Shaped<Record<string, boolean>>
      btwRows: Shaped<number>
      btwOffset: Shaped<number>
      btwDraft: Shaped<string>
    }
  }
}
