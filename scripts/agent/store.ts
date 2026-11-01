import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { HistoryEntry, LoopState, QueueFile, WorkItem } from './types'

const QUEUE_PATH = join(process.cwd(), 'agent', 'queue.json')
const STATE_PATH = join(process.cwd(), '.agent', 'state.json')
const DEFAULT_BRANCH = 'agent/loop'

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    throw new Error(`Cannot read valid JSON from ${path}; refusing to reset persisted work`)
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}

function isIteration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function loadQueue(): QueueFile {
  if (!existsSync(QUEUE_PATH)) {
    return { version: 1, updatedAt: new Date().toISOString(), items: [] }
  }
  const queue = readJson<QueueFile>(QUEUE_PATH)
  if (!queue || !Array.isArray(queue.items) || (queue.lastIteration !== undefined && !isIteration(queue.lastIteration))) {
    throw new Error(`Invalid work queue at ${QUEUE_PATH}; refusing to reset persisted work`)
  }
  return queue
}

export function saveQueue(queue: QueueFile): void {
  queue.updatedAt = new Date().toISOString()
  writeJson(QUEUE_PATH, queue)
}

export function loadState(): LoopState {
  const state = readJson<LoopState>(STATE_PATH)
  if (existsSync(STATE_PATH) && (
    !state || !isIteration(state.iteration) || typeof state.branch !== 'string' ||
    typeof state.startedAt !== 'string' || !Array.isArray(state.history) ||
    !state.history.every((entry) => entry && isIteration(entry.iteration))
  )) {
    throw new Error(`Invalid runtime state at ${STATE_PATH}; refusing to reset persisted work`)
  }

  const queue = loadQueue()
  const iteration = queue.items.reduce(
    (maximum, item) => isIteration(item.completedIteration) ? Math.max(maximum, item.completedIteration) : maximum,
    queue.lastIteration ?? 0
  )
  const recovered: HistoryEntry[] = queue.items
    .filter((item) => item.status === 'done' && isIteration(item.completedIteration) && item.completedIteration > 0)
    .map((item): HistoryEntry => ({
      iteration: item.completedIteration!, itemId: item.id, title: item.title, lane: item.lane,
      status: 'completed', evidence: item.evidence, at: item.completedAt ?? queue.updatedAt
    }))
    .sort((a, b) => a.iteration - b.iteration)

  if (!state) {
    return {
      version: 1,
      iteration,
      branch: DEFAULT_BRANCH,
      startedAt: recovered[0]?.at ?? new Date().toISOString(),
      history: recovered
    }
  }

  const history = [...state.history]
  for (const entry of recovered) {
    if (!history.some((existing) => existing.iteration === entry.iteration && existing.itemId === entry.itemId && existing.status === 'completed')) {
      history.push(entry)
    }
  }
  history.sort((a, b) => a.iteration - b.iteration)
  return {
    ...state,
    iteration: history.reduce((maximum, entry) => Math.max(maximum, entry.iteration), Math.max(state.iteration, iteration)),
    history
  }
}

export function saveState(state: LoopState): void {
  writeJson(STATE_PATH, state)
}

export function statePath(): string {
  return STATE_PATH
}

export function queuePath(): string {
  return QUEUE_PATH
}

export function findItem(queue: QueueFile, id: string): WorkItem | undefined {
  return queue.items.find((item) => item.id === id)
}

/**
 * Claimable items are pending work that is not already in flight. Blocked items
 * are surfaced by `status` but never handed out automatically.
 */
export function nextPending(queue: QueueFile): WorkItem | undefined {
  return queue.items
    .filter((item) => item.status === 'pending')
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))[0]
}

export function summarize(queue: QueueFile, state: LoopState): string {
  const byStatus = (status: WorkItem['status']) =>
    queue.items.filter((item) => item.status === status).length

  const lanes = (['security', 'performance', 'quality', 'frontend', 'browser'] as const)
    .map((lane) => {
      const count = queue.items.filter((item) => item.lane === lane && item.status !== 'done').length
      return count ? `  ${lane.padEnd(12)} ${count}` : ''
    })
    .filter(Boolean)
    .join('\n')

  const done = byStatus('done')
  const total = queue.items.length

  return [
    `branch        ${state.branch}`,
    `iteration     ${state.iteration}`,
    `items         ${total} total | ${done} done | ${byStatus('pending')} pending | ${byStatus('in_progress')} in progress | ${byStatus('blocked')} blocked`,
    lanes ? `open by lane:\n${lanes}` : 'open by lane: none',
    state.lastGate
      ? `last gate     ${state.lastGate.ok ? 'GREEN' : 'RED'} @ ${state.lastGate.ranAt}`
      : 'last gate     never run'
  ].join('\n')
}
