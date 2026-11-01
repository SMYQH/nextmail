import { spawnSync } from 'child_process'
import { existsSync, statSync } from 'fs'
import { isAbsolute, relative, resolve } from 'path'
import { runGate } from './gate'
import {
  findItem,
  loadQueue,
  loadState,
  nextPending,
  saveQueue,
  saveState,
  summarize
} from './store'
import type { Lane, WorkItem } from './types'

interface Args {
  command: string
  positionals: string[]
  flags: Record<string, string | boolean>
}

function parseArgs(argv: string[]): Args {
  const [command = 'status', ...rest] = argv
  const positionals: string[] = []
  const flags: Record<string, string | boolean> = {}

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }
    const key = token.slice(2)
    const next = rest[index + 1]
    if (next && !next.startsWith('--')) {
      flags[key] = next
      index += 1
    } else {
      flags[key] = true
    }
  }

  return { command, positionals, flags }
}

function git(args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd: process.cwd(), encoding: 'utf-8' })
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  }
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function printGate(gate: Awaited<ReturnType<typeof runGate>>): void {
  for (const step of gate.steps) {
    const status = step.ok ? 'PASS' : 'FAIL'
    console.log(`  [${status}] ${step.name.padEnd(8)} ${step.summary}  (${step.durationMs}ms)`)
    if (!step.ok) {
      console.log(`         $ ${step.command}`)
      console.log(step.outputTail.split('\n').slice(-25).map((line) => `         ${line}`).join('\n'))
    }
  }
  console.log(gate.ok ? 'GATE GREEN' : 'GATE RED')
}

function cmdStatus(args: Args): void {
  const queue = loadQueue()
  const state = loadState()

  if (args.flags.json) {
    console.log(JSON.stringify({ queue, state }, null, 2))
    return
  }

  console.log(summarize(queue, state))
  console.log('')

  const open = queue.items
    .filter((item) => item.status !== 'done')
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))

  if (open.length === 0) {
    console.log('queue empty')
    return
  }

  console.log('open items:')
  for (const item of open) {
    const attempts = item.attempts ? ` attempts=${item.attempts}` : ''
    console.log(`  ${item.id.padEnd(10)} p${item.priority} [${item.lane}] ${item.status.padEnd(11)} ${item.title}${attempts}`)
  }
}

function cmdNext(args: Args): void {
  const queue = loadQueue()
  const item = nextPending(queue)

  if (!item) {
    console.log(JSON.stringify({ empty: true }, null, 2))
    return
  }

  if (args.flags.json) {
    console.log(JSON.stringify(item, null, 2))
    return
  }

  console.log(`id         ${item.id}`)
  console.log(`lane       ${item.lane}`)
  console.log(`priority   ${item.priority}`)
  console.log(`title      ${item.title}`)
  console.log(`intent     ${item.intent}`)
  console.log(`source     ${item.source ?? 'n/a'}`)
  console.log('acceptance:')
  for (const criterion of item.acceptance) console.log(`  - ${criterion}`)
}

function cmdClaim(args: Args): void {
  const id = args.positionals[0]
  if (!id) fail('usage: agent:claim <id> [--by <agent>]')

  const queue = loadQueue()
  const item = findItem(queue, id)
  if (!item) fail(`unknown work item: ${id}`)
  if (item.status === 'done') fail(`work item already done: ${id}`)
  if (item.status === 'in_progress') fail(`work item already in progress: ${id}`)

  if (item.status !== 'pending') fail(`work item is not pending: ${id}`)
  const active = queue.items.find((candidate) => candidate.status === 'in_progress')
  if (active) fail(`finish or release the active work item first: ${active.id}`)

  item.status = 'in_progress'
  item.attempts += 1
  item.claimedBy = typeof args.flags.by === 'string' ? args.flags.by : 'main-agent'
  item.claimedAt = new Date().toISOString()

  saveQueue(queue)
  console.log(`claimed ${id} by ${item.claimedBy} (attempt ${item.attempts})`)
}

async function cmdComplete(args: Args): Promise<void> {
  const id = args.positionals[0]
  if (!id) fail('usage: agent:complete <id> --evidence "<text>" [--commit <sha>]')
  if (args.flags['skip-gate'] || args.flags['no-browser']) fail('completion requires the full gate; bypass flags are forbidden')
  if (typeof args.flags.evidence !== 'string' || !args.flags.evidence.trim()) fail('completion requires non-empty --evidence')

  const queue = loadQueue()
  const state = loadState()
  const item = findItem(queue, id)
  if (!item) fail(`unknown work item: ${id}`)
  if (item.status !== 'in_progress') fail(`work item is not in progress: ${id} (status=${item.status})`)

  console.log('running gate before recording completion...')
  const gate = await runGate()
  state.lastGate = gate
  printGate(gate)
  if (!gate.ok) {
    saveState(state)
    fail('gate is red; refusing to record completion')
  }

  state.iteration += 1
  queue.lastIteration = state.iteration
  item.status = 'done'
  item.completedIteration = state.iteration
  item.completedAt = new Date().toISOString()
  item.evidence = typeof args.flags.evidence === 'string' ? args.flags.evidence : undefined

  state.history.push({
    iteration: state.iteration,
    itemId: item.id,
    title: item.title,
    lane: item.lane,
    status: 'completed',
    commit: typeof args.flags.commit === 'string' ? args.flags.commit : undefined,
    evidence: item.evidence,
    at: new Date().toISOString()
  })

  saveQueue(queue)
  saveState(state)
  console.log(`completed ${id} at iteration ${state.iteration}`)
}

function cmdFail(args: Args): void {
  const id = args.positionals[0]
  if (!id) fail('usage: agent:fail <id> --reason "<text>"')

  const queue = loadQueue()
  const state = loadState()
  const item = findItem(queue, id)
  if (!item) fail(`unknown work item: ${id}`)

  const reason = typeof args.flags.reason === 'string' ? args.flags.reason : 'unspecified'

  item.status = 'pending'
  item.notes = reason
  item.claimedBy = undefined

  state.iteration += 1
  queue.lastIteration = state.iteration
  state.history.push({
    iteration: state.iteration,
    itemId: item.id,
    title: item.title,
    lane: item.lane,
    status: 'failed',
    reason,
    at: new Date().toISOString()
  })

  saveQueue(queue)
  saveState(state)
  console.log(`failed ${id}: ${reason}`)
  console.log('returned to pending for a later attempt')
}

function cmdBlock(args: Args): void {
  const id = args.positionals[0]
  if (!id) fail('usage: agent:block <id> --reason "<text>"')

  const queue = loadQueue()
  const state = loadState()
  const item = findItem(queue, id)
  if (!item) fail(`unknown work item: ${id}`)

  const reason = typeof args.flags.reason === 'string' ? args.flags.reason : 'unspecified'
  item.status = 'blocked'
  item.notes = reason

  state.iteration += 1
  queue.lastIteration = state.iteration
  state.history.push({
    iteration: state.iteration,
    itemId: item.id,
    title: item.title,
    lane: item.lane,
    status: 'blocked',
    reason,
    at: new Date().toISOString()
  })

  saveQueue(queue)
  saveState(state)
  console.log(`blocked ${id}: ${reason}`)
}

function cmdUnblock(args: Args): void {
  const id = args.positionals[0]
  if (!id) fail('usage: agent:unblock <id>')

  const queue = loadQueue()
  const item = findItem(queue, id)
  if (!item) fail(`unknown work item: ${id}`)

  item.status = 'pending'
  saveQueue(queue)
  console.log(`unblocked ${id}`)
}

async function cmdGate(args: Args): Promise<void> {
  const gate = await runGate({ includeBrowser: !args.flags['no-browser'] })
  const state = loadState()
  state.lastGate = gate
  saveState(state)
  printGate(gate)
  if (!gate.ok) process.exit(1)
}

function cmdCommit(args: Args): void {
  const message = typeof args.flags.message === 'string' ? args.flags.message : ''
  if (!message) fail('usage: agent:commit --message "<msg>" --files "a.ts,b.ts"')

  const rawFiles = typeof args.flags.files === 'string' ? args.flags.files : ''
  const files = rawFiles.split(',').map((file) => file.trim()).filter(Boolean)
  if (files.length === 0) fail('no files given; pass --files "a.ts,b.ts"')
  for (const file of files) {
    const local = relative(process.cwd(), resolve(file))
    if (!local || local === '..' || local.startsWith('../') || local.startsWith('..\\') || isAbsolute(local)) {
      fail(`commit paths must name individual files inside this repository: ${file}`)
    }
    if (existsSync(file) && !statSync(file).isFile()) fail(`directory commits are forbidden: ${file}`)
    if (/[\r\n]/.test(file)) fail(`newlines are forbidden in commit paths: ${file}`)
  }

  const state = loadState()
  const branch = typeof args.flags.branch === 'string' ? args.flags.branch : state.branch
  if (branch !== 'agent/loop') fail('commits are restricted to the local agent/loop branch')

  const existingStaged = git(['diff', '--cached', '--name-only'])
  if (existingStaged.code !== 0) fail('cannot inspect the Git index')
  if (existingStaged.stdout.trim()) fail('index already contains staged changes; refusing to include user work')

  const current = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (current.code !== 0) fail('not inside a git repository')

  if (current.stdout.trim() !== branch) {
    const exists = git(['rev-parse', '--verify', branch]).code === 0
    const checkout = exists
      ? git(['checkout', branch])
      : git(['checkout', '-b', branch])
    if (checkout.code !== 0) fail(`failed to switch to branch ${branch}: ${checkout.stderr.trim()}`)
    console.log(`switched to branch ${branch}`)
  }

  const add = git(['--literal-pathspecs', 'add', '--', ...files])
  if (add.code !== 0) fail(`git add failed: ${add.stderr.trim()}`)

  const staged = git(['diff', '--cached', '--name-only'])
  if (!staged.stdout.trim()) fail('nothing staged; check the --files list')

  const commit = git(['--literal-pathspecs', 'commit', '--only', '-m', message, '--', ...files])
  if (commit.code !== 0) fail(`git commit failed: ${commit.stderr.trim() || commit.stdout.trim()}`)

  const sha = git(['rev-parse', '--short', 'HEAD']).stdout.trim()
  const leftover = git(['status', '--porcelain'])
  const remaining = leftover.stdout.trim()

  state.branch = branch
  saveState(state)

  console.log(`committed ${sha} on ${branch}`)
  console.log(`staged files:\n${staged.stdout.trim().split('\n').map((line) => `  ${line}`).join('\n')}`)
  if (remaining) {
    console.log('working tree still has uncommitted changes (not touched by this commit):')
    console.log(remaining.split('\n').map((line) => `  ${line}`).join('\n'))
  } else {
    console.log('working tree clean')
  }
}

function cmdLog(args: Args): void {
  const state = loadState()
  const limit = typeof args.flags.limit === 'string' ? Number(args.flags.limit) : 20
  const entries = state.history.slice(-limit).reverse()

  if (entries.length === 0) {
    console.log('no iterations recorded')
    return
  }

  for (const entry of entries) {
    const commit = entry.commit ? ` commit=${entry.commit}` : ''
    console.log(`#${entry.iteration} ${entry.status.padEnd(9)} ${entry.itemId.padEnd(10)} ${entry.title}${commit}`)
    if (entry.evidence) console.log(`         evidence: ${entry.evidence}`)
    if (entry.reason) console.log(`         reason: ${entry.reason}`)
  }
}

function cmdEnqueue(args: Args): void {
  const id = typeof args.flags.id === 'string' ? args.flags.id : ''
  const title = typeof args.flags.title === 'string' ? args.flags.title : ''
  const intent = typeof args.flags.intent === 'string' ? args.flags.intent : ''
  const lane = (typeof args.flags.lane === 'string' ? args.flags.lane : 'quality') as Lane
  const priority = typeof args.flags.priority === 'string' ? Number(args.flags.priority) : 50
  const source = typeof args.flags.source === 'string' ? args.flags.source : undefined
  const acceptance = Array.isArray(args.flags.acceptance)
    ? args.flags.acceptance.map(String)
    : typeof args.flags.acceptance === 'string'
      ? [args.flags.acceptance]
      : []

  if (!id || !title || !intent) fail('usage: agent:enqueue --id <id> --title <t> --intent <i> [--lane] [--priority] [--source] [--acceptance]')

  const queue = loadQueue()
  if (findItem(queue, id)) fail(`work item already exists: ${id}`)

  const item: WorkItem = {
    id,
    lane,
    title,
    intent,
    acceptance,
    source,
    priority,
    status: 'pending',
    attempts: 0
  }

  queue.items.push(item)
  saveQueue(queue)
  console.log(`enqueued ${id}: ${title}`)
}

function cmdBranch(args: Args): void {
  const state = loadState()
  const branch = typeof args.flags.name === 'string' ? args.flags.name : ''
  if (!branch) fail('usage: agent:branch --name <branch>')
  state.branch = branch
  saveState(state)
  console.log(`loop branch set to ${branch}`)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  switch (args.command) {
    case 'status':
      return cmdStatus(args)
    case 'next':
      return cmdNext(args)
    case 'claim':
      return cmdClaim(args)
    case 'complete':
      return cmdComplete(args)
    case 'fail':
      return cmdFail(args)
    case 'block':
      return cmdBlock(args)
    case 'unblock':
      return cmdUnblock(args)
    case 'gate':
      return cmdGate(args)
    case 'commit':
      return cmdCommit(args)
    case 'log':
      return cmdLog(args)
    case 'enqueue':
      return cmdEnqueue(args)
    case 'branch':
      return cmdBranch(args)
    default:
      fail(`unknown command: ${args.command}\ncommands: status, next, claim, complete, fail, block, unblock, gate, commit, log, enqueue, branch`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
