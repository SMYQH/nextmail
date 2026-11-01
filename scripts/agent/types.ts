export type Lane = 'security' | 'performance' | 'quality' | 'frontend' | 'browser'

export type WorkItemStatus = 'pending' | 'in_progress' | 'done' | 'blocked'

export interface WorkItem {
  id: string
  lane: Lane
  title: string
  intent: string
  acceptance: string[]
  source?: string
  priority: number
  migration?: boolean
  browserEvidence?: boolean
  status: WorkItemStatus
  attempts: number
  claimedBy?: string
  claimedAt?: string
  completedIteration?: number
  completedAt?: string
  evidence?: string
  notes?: string
}

export interface QueueFile {
  version: number
  updatedAt: string
  lastIteration?: number
  items: WorkItem[]
}

export interface HistoryEntry {
  iteration: number
  itemId: string
  title: string
  lane: Lane
  status: 'completed' | 'failed' | 'blocked' | 'skipped'
  commit?: string
  evidence?: string
  reason?: string
  at: string
}

export interface GateStepResult {
  name: string
  command: string
  exitCode: number | null
  ok: boolean
  durationMs: number
  skipped: boolean
  summary: string
  outputTail: string
}

export interface GateResult {
  ok: boolean
  ranAt: string
  steps: GateStepResult[]
}

export interface LoopState {
  version: number
  iteration: number
  branch: string
  startedAt: string
  lastGate?: GateResult
  history: HistoryEntry[]
}
