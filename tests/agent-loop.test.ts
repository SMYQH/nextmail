import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { LoopState, QueueFile, WorkItem } from '../scripts/agent/types'

const root = process.cwd()
const require = createRequire(import.meta.url)
const loader = pathToFileURL(require.resolve('tsx/esm')).href
const cli = resolve(root, 'scripts/agent/loop.ts')

function fixture(t: TestContext) {
  const parent = join(root, '.test', 'results', 'agent-fixtures')
  mkdirSync(parent, { recursive: true })
  const cwd = mkdtempSync(join(parent, 'test-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  mkdirSync(join(cwd, 'agent'))
  const queue: QueueFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    items: ['ONE', 'TWO'].map((id, index): WorkItem => ({
      id, lane: 'quality', title: id, intent: 'Test safety', acceptance: ['Safe'],
      priority: index, status: 'pending', attempts: 0
    }))
  }
  const save = (value: QueueFile) => writeFileSync(join(cwd, 'agent/queue.json'), JSON.stringify(value))
  save(queue)
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', loader, cli, ...args], {
    cwd, encoding: 'utf-8', timeout: 30_000
  })
  const read = () => JSON.parse(readFileSync(join(cwd, 'agent/queue.json'), 'utf-8')) as QueueFile
  const state = () => {
    const result = run('status', '--json')
    assert.equal(result.status, 0, result.stderr)
    return (JSON.parse(result.stdout) as { state: LoopState }).state
  }
  const persistState = (value: LoopState) => {
    mkdirSync(join(cwd, '.agent'), { recursive: true })
    writeFileSync(join(cwd, '.agent/state.json'), JSON.stringify(value))
  }
  return { cwd, run, read, save, state, persistState }
}

test('loop claims only one pending item at a time', t => {
  const { run, read } = fixture(t)
  assert.equal(run('claim', 'ONE').status, 0)
  const second = run('claim', 'TWO')
  assert.equal(second.status, 1)
  assert.match(second.stderr, /active work item/)
  assert.deepEqual(read().items.map(item => item.status), ['in_progress', 'pending'])
})

test('completion rejects bypass flags and missing evidence without changing the queue', t => {
  const { run, read } = fixture(t)
  assert.equal(run('claim', 'ONE').status, 0)
  for (const flag of ['--skip-gate', '--no-browser']) {
    const result = run('complete', 'ONE', flag, '--evidence', 'Not sufficient')
    assert.equal(result.status, 1)
    assert.match(result.stderr, /bypass flags are forbidden/)
    assert.equal(read().items[0].status, 'in_progress')
  }
  const result = run('complete', 'ONE')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /requires non-empty --evidence/)
})

test('commit refuses an existing staged user change', t => {
  const { cwd, run } = fixture(t)
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf-8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git('init', '--initial-branch=main')
  writeFileSync(join(cwd, 'user.txt'), 'User-owned work\n')
  writeFileSync(join(cwd, 'loop.txt'), 'Loop work\n')
  git('add', '--', 'user.txt')
  const result = run('commit', '--message', 'test: 安全边界', '--files', 'loop.txt')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /already contains staged changes/)
  assert.equal(git('diff', '--cached', '--name-only'), 'user.txt')
  assert.equal(git('branch', '--show-current'), 'main')
})

test('commit rejects directory scope and non-loop branches', t => {
  const { cwd, run } = fixture(t)
  const directory = run('commit', '--message', 'test: 安全边界', '--files', 'agent')
  assert.equal(directory.status, 1)
  assert.match(directory.stderr, /directory commits are forbidden/)
  writeFileSync(join(cwd, 'loop.txt'), 'Loop work\n')
  const branch = run('commit', '--message', 'test: 安全边界', '--files', 'loop.txt', '--branch', 'main')
  assert.equal(branch.status, 1)
  assert.match(branch.stderr, /restricted to the local agent\/loop branch/)
})

test('commit treats bracket paths literally and preserves unrelated modifications', t => {
  const { cwd, run } = fixture(t)
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf-8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git('init', '--initial-branch=main')
  git('config', 'user.name', 'Agent Test')
  git('config', 'user.email', 'agent-test@example.invalid')

  const scopedPaths = ['a[b].txt', 'app/[locale]/page.tsx']
  const pathspecMatches = ['ab.txt', 'app/l/page.tsx']
  const unrelatedPath = 'unrelated.txt'
  mkdirSync(join(cwd, 'app/[locale]'), { recursive: true })
  mkdirSync(join(cwd, 'app/l'), { recursive: true })
  for (const file of scopedPaths) writeFileSync(join(cwd, file), 'initial scoped content\n')
  for (const file of pathspecMatches) writeFileSync(join(cwd, file), 'initial matching content\n')
  writeFileSync(join(cwd, unrelatedPath), 'initial unrelated content\n')
  git('add', '--all')
  git('commit', '-m', 'test: initialize fixture')

  for (const file of scopedPaths) writeFileSync(join(cwd, file), 'scoped update\n')
  for (const file of pathspecMatches) writeFileSync(join(cwd, file), 'unrelated matching update\n')
  writeFileSync(join(cwd, unrelatedPath), 'unrelated update\n')

  const result = run('commit', '--message', 'test: commit scoped files', '--files', scopedPaths.join(','))
  assert.equal(result.status, 0, result.stderr)
  assert.equal(git('branch', '--show-current'), 'agent/loop')
  assert.deepEqual(git('diff', 'HEAD^', 'HEAD', '--name-only').split('\n').sort(), [...scopedPaths].sort())
  assert.equal(git('diff', '--cached', '--name-only'), '')
  assert.deepEqual(git('diff', '--name-only').split('\n').sort(), [...pathspecMatches, unrelatedPath].sort())
  for (const file of scopedPaths) assert.equal(readFileSync(join(cwd, file), 'utf8'), 'scoped update\n')
  for (const file of pathspecMatches) assert.equal(readFileSync(join(cwd, file), 'utf8'), 'unrelated matching update\n')
  assert.equal(readFileSync(join(cwd, unrelatedPath), 'utf8'), 'unrelated update\n')
})

test('missing runtime state recovers sorted completion evidence and the highest iteration', t => {
  const { read, save, state } = fixture(t)
  const queue = read()
  queue.items[0] = { ...queue.items[0], status: 'done', completedIteration: 7, completedAt: '2026-01-07T00:00:00.000Z', evidence: 'seventh check' }
  queue.items[1] = { ...queue.items[1], status: 'done', completedIteration: 3, completedAt: '2026-01-03T00:00:00.000Z', evidence: 'third check' }
  save(queue)
  const recovered = state()
  assert.equal(recovered.iteration, 7)
  assert.equal(recovered.branch, 'agent/loop')
  assert.deepEqual(recovered.history.map(entry => [entry.iteration, entry.itemId, entry.evidence]), [[3, 'TWO', 'third check'], [7, 'ONE', 'seventh check']])
  assert.equal(recovered.lastGate, undefined)
})

test('failed and blocked round numbers survive removal of runtime state', t => {
  const { cwd, run, read, state } = fixture(t)
  assert.equal(run('claim', 'ONE').status, 0)
  assert.equal(run('fail', 'ONE', '--reason', 'synthetic failure').status, 0)
  assert.equal(read().lastIteration, 1)
  rmSync(join(cwd, '.agent/state.json'))
  assert.equal(state().iteration, 1)
  assert.equal(run('claim', 'ONE').status, 0)
  assert.equal(run('block', 'ONE', '--reason', 'synthetic decision').status, 0)
  assert.equal(read().lastIteration, 2)
  rmSync(join(cwd, '.agent/state.json'))
  assert.equal(state().iteration, 2)
  assert.deepEqual(state().history, [])
})

test('tracked high-water counters prevent reuse when a reopened item has no current completion', t => {
  const { read, save, state, run } = fixture(t)
  const queue = read()
  queue.lastIteration = 41
  queue.items[0].completedIteration = 37
  save(queue)
  assert.equal(state().iteration, 41)
  assert.deepEqual(state().history, [])
  assert.equal(run('block', 'TWO', '--reason', 'test').status, 0)
  assert.equal(read().lastIteration, 42)
})

test('stale runtime counters reconcile with tracked completion without losing failure history', t => {
  const { read, save, state, persistState, run } = fixture(t)
  const queue = read()
  queue.items[0] = { ...queue.items[0], status: 'done', completedIteration: 11, completedAt: '2026-01-11T00:00:00.000Z', evidence: 'completed' }
  save(queue)
  persistState({
    version: 1, iteration: 2, branch: 'agent/loop', startedAt: '2026-01-01T00:00:00.000Z',
    history: [{ iteration: 2, itemId: 'TWO', title: 'TWO', lane: 'quality', status: 'failed', reason: 'earlier failure', at: '2026-01-02T00:00:00.000Z' }]
  })
  assert.equal(state().iteration, 11)
  assert.deepEqual(state().history.map(entry => [entry.iteration, entry.status]), [[2, 'failed'], [11, 'completed']])
  assert.equal(run('block', 'TWO', '--reason', 'test').status, 0)
  assert.equal(read().lastIteration, 12)
})

test('normal persisted runtime state is preserved and recovered history is not duplicated', t => {
  const { read, save, state, persistState } = fixture(t)
  const queue = read()
  queue.items[0] = { ...queue.items[0], status: 'done', completedIteration: 5, completedAt: '2026-01-05T00:00:00.000Z', evidence: 'checked' }
  queue.lastIteration = 5
  save(queue)
  const existing: LoopState = {
    version: 1, iteration: 5, branch: 'agent/loop', startedAt: '2026-01-01T00:00:00.000Z',
    lastGate: { ok: false, ranAt: '2026-01-05T00:00:00.000Z', steps: [] },
    history: [{ iteration: 5, itemId: 'ONE', title: 'ONE', lane: 'quality', status: 'completed', evidence: 'checked', commit: 'synthetic-sha', at: '2026-01-05T00:00:00.000Z' }]
  }
  persistState(existing)
  assert.deepEqual(state(), existing)
})

test('invalid persisted JSON or state shape is rejected without overwriting files', t => {
  for (const [target, content] of [
    ['queue', '{invalid'], ['state', '{invalid'], ['queue', '{"items":null}'],
    ['queue', '{"items":[],"lastIteration":-1}'],
    ['state', '{"version":1,"iteration":-1,"history":[]}'], ['state', 'null'],
    ['state', '{"iteration":0,"branch":"agent/loop","startedAt":"2026-01-01T00:00:00.000Z","history":[null]}'],
  ]) {
    const { cwd, run } = fixture(t)
    const queuePath = join(cwd, 'agent/queue.json')
    mkdirSync(join(cwd, '.agent'), { recursive: true })
    const path = target === 'queue' ? queuePath : join(cwd, '.agent/state.json')
    writeFileSync(path, content)
    const before = readFileSync(queuePath, 'utf-8')
    const result = run('status', '--json')
    assert.equal(result.status, 1)
    assert.match(result.stderr, /refusing to reset persisted work/)
    assert.equal(readFileSync(path, 'utf-8'), content)
    assert.equal(readFileSync(queuePath, 'utf-8'), before)
  }
})
