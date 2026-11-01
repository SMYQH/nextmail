import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runGateStep } from '../scripts/agent/gate'
import { runSnapshotStep } from '../scripts/agent/snapshot'

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      readFileSync(path, 'utf8')
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  assert.fail(`fixture did not create ${path}`)
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return !isAlive(pid)
}

function commandFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'nextmail-agent-timeout-'))
  const parentScript = join(directory, 'parent.cjs')
  const grandchildScript = join(directory, 'grandchild.cjs')
  const pidFiles = ['parent.pid', 'ignore-termination.pid', 'closed-stdio.pid']

  writeFileSync(parentScript, [
    "const { spawn } = require('node:child_process')",
    "require('node:fs').writeFileSync('parent.pid', String(process.pid))",
    "process.stdout.write('fixture-parent-started\\n')",
    `spawn(process.execPath, [${JSON.stringify(grandchildScript)}, ${JSON.stringify(join(directory, 'ignore-termination.pid'))}, 'ignore-termination'], { stdio: 'inherit' })`,
    `spawn(process.execPath, [${JSON.stringify(grandchildScript)}, ${JSON.stringify(join(directory, 'closed-stdio.pid'))}, 'closed-stdio'], { stdio: 'inherit' })`
  ].join('\n'))
  writeFileSync(grandchildScript, [
    "const { writeFileSync } = require('node:fs')",
    'writeFileSync(process.argv[2], String(process.pid))',
    "process.on('SIGTERM', () => {})",
    "process.stdout.write('fixture-grandchild-' + process.argv[3] + '-ready pid=' + process.pid + '\\n', () => {",
    "  if (process.argv[3] === 'closed-stdio') {",
    '    process.stdout.destroy()',
    '    process.stderr.destroy()',
    '    process.stdin.destroy()',
    '  }',
    '})',
    'setInterval(() => {}, 1000)'
  ].join('\n'))

  t.after(() => {
    const cleanupSignal: NodeJS.Signals = process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL'
    for (const name of pidFiles.slice(1).concat(pidFiles[0])) {
      try {
        const pid = Number(readFileSync(join(directory, name), 'utf8'))
        if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid)) {
          process.kill(pid, cleanupSignal)
        }
      } catch {
        // A fixture may have exited or not started before cleanup.
      }
    }
    rmSync(directory, { recursive: true, force: true })
  })

  const command = 'node parent.cjs'
  return {
    command,
    cwd: directory,
    pidFiles: pidFiles.map((name) => join(directory, name)),
    capturePids() {
      return pidFiles.map((name) => {
        const pid = Number(readFileSync(join(directory, name), 'utf8'))
        assert.ok(Number.isInteger(pid) && pid > 0)
        assert.notEqual(pid, process.pid)
        return pid
      })
    }
  }
}

async function verifyTimeoutKillsGrandchild(
  t: TestContext,
  run: (command: string, cwd: string) => ReturnType<typeof runGateStep>
): Promise<void> {
  const fixture = commandFixture(t)
  const started = Date.now()
  const resultPromise = run(fixture.command, fixture.cwd)

  for (const pidFile of fixture.pidFiles) {
    await waitForFile(pidFile, 5_000)
  }
  const pids = fixture.capturePids()
  for (const pid of pids) {
    assert.ok(isAlive(pid), `fixture process ${pid} should be alive before timeout`)
  }

  const result = await resultPromise
  assert.equal(result.timedOut, true)
  assert.match(result.output, /fixture-parent-started/)
  assert.match(result.output, new RegExp(`fixture-grandchild-ignore-termination-ready pid=${pids[1]}`))
  assert.match(result.output, new RegExp(`fixture-grandchild-closed-stdio-ready pid=${pids[2]}`))
  assert.ok(result.durationMs < 5_000, `command should settle within its timeout bound; got ${result.durationMs}ms`)
  for (const pid of pids) {
    assert.ok(await waitForExit(pid, 2_000), `fixture process ${pid} should be dead after timeout`)
  }
  assert.ok(Date.now() - started < 5_500, 'timeout completion should remain bounded')
}

async function verifyNormalAndSpawnErrorBehavior(
  t: TestContext,
  run: (command: string, cwd: string) => ReturnType<typeof runGateStep>
): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'nextmail-agent-command-outcome-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))

  const normal = await run('echo preserved-command-output', cwd)
  assert.equal(normal.exitCode, 0)
  assert.equal(normal.timedOut, false)
  assert.match(normal.output, /preserved-command-output/)

  const spawnError = await run('echo this-command-must-not-run', join(cwd, 'missing-cwd'))
  assert.equal(spawnError.exitCode, null)
  assert.equal(spawnError.timedOut, false)
  assert.match(spawnError.output, /spawn .* ENOENT/)
}

test('gate timeout kills a hanging grandchild and settles despite inherited pipes', async (t) => {
  await verifyTimeoutKillsGrandchild(t, (command, cwd) => runGateStep({
    name: 'lint', command, timeoutMs: 1_500, required: true
  }, cwd))
})

test('snapshot timeout kills a hanging grandchild and settles despite inherited pipes', async (t) => {
  await verifyTimeoutKillsGrandchild(t, (command, cwd) => runSnapshotStep({
    name: 'lint', command, timeoutMs: 1_500
  }, cwd))
})

test('gate escalates to SIGKILL after the root closes with a stream-closing grandchild alive', {
  skip: process.platform === 'win32'
}, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'nextmail-agent-timeout-escalation-'))
  const parentScript = join(cwd, 'parent.cjs')
  const grandchildScript = join(cwd, 'grandchild.cjs')
  const parentPidFile = join(cwd, 'parent.pid')
  const pidFile = join(cwd, 'grandchild.pid')
  const signalFile = join(cwd, 'term-signal')

  writeFileSync(parentScript, [
    "const { spawn } = require('node:child_process')",
    "require('node:fs').writeFileSync('parent.pid', String(process.pid))",
    `spawn(process.execPath, [${JSON.stringify(grandchildScript)}, ${JSON.stringify(pidFile)}, ${JSON.stringify(signalFile)}], { stdio: 'inherit' })`,
    'setInterval(() => {}, 1000)'
  ].join('\n'))
  writeFileSync(grandchildScript, [
    "const { writeFileSync } = require('node:fs')",
    'writeFileSync(process.argv[2], String(process.pid))',
    "process.on('SIGTERM', () => {",
    "  writeFileSync(process.argv[3], 'received')",
    '  process.stdout.destroy()',
    '  process.stderr.destroy()',
    '  process.stdin.destroy()',
    '})',
    "process.stdout.write('fixture-ignore-and-close-ready pid=' + process.pid + '\\n')",
    'setInterval(() => {}, 1000)'
  ].join('\n'))

  t.after(() => {
    for (const path of [pidFile, parentPidFile]) {
      try {
        const pid = Number(readFileSync(path, 'utf8'))
        if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid)) {
          process.kill(pid, 'SIGKILL')
        }
      } catch {
        // A fixture may have exited or not started before cleanup.
      }
    }
    rmSync(cwd, { recursive: true, force: true })
  })

  const started = Date.now()
  const resultPromise = runGateStep({
    name: 'lint', command: 'node parent.cjs', timeoutMs: 1_500, required: true
  }, cwd)
  await waitForFile(parentPidFile, 5_000)
  await waitForFile(pidFile, 5_000)
  const parentPid = Number(readFileSync(parentPidFile, 'utf8'))
  const pid = Number(readFileSync(pidFile, 'utf8'))
  assert.ok(Number.isInteger(parentPid) && parentPid > 0 && parentPid !== process.pid)
  assert.ok(Number.isInteger(pid) && pid > 0 && pid !== process.pid)
  assert.ok(isAlive(parentPid), `fixture parent ${parentPid} should be alive before timeout`)
  assert.ok(isAlive(pid), `fixture grandchild ${pid} should be alive before timeout`)

  await waitForFile(signalFile, 4_000)
  assert.ok(isAlive(pid), `grandchild ${pid} should remain alive after closing its streams`)
  const result = await resultPromise
  assert.equal(result.timedOut, true)
  assert.match(result.output, new RegExp(`fixture-ignore-and-close-ready pid=${pid}`))
  assert.match(readFileSync(signalFile, 'utf8'), /received/)
  assert.ok(result.durationMs >= 1_650, `SIGKILL escalation should run before settling; got ${result.durationMs}ms`)
  assert.ok(result.durationMs < 5_000, `command should settle within its timeout bound; got ${result.durationMs}ms`)
  assert.ok(await waitForExit(parentPid, 2_000), `fixture parent ${parentPid} should be dead after timeout`)
  assert.ok(await waitForExit(pid, 2_000), `fixture grandchild ${pid} should be dead after escalation`)
  assert.ok(Date.now() - started < 5_500, 'timeout completion should remain bounded')
})

test('gate runner preserves normal output and spawn errors', async (t) => {
  await verifyNormalAndSpawnErrorBehavior(t, (command, cwd) => runGateStep({
    name: 'lint', command, timeoutMs: 2_000, required: true
  }, cwd))
})

test('snapshot runner preserves normal output and spawn errors', async (t) => {
  await verifyNormalAndSpawnErrorBehavior(t, (command, cwd) => runSnapshotStep({
    name: 'lint', command, timeoutMs: 2_000
  }, cwd))
})
