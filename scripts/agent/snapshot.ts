import { spawnSync } from 'child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync, unlinkSync } from 'fs'
import { isAbsolute, join, relative, resolve } from 'path'
import { pathToFileURL } from 'url'
import { runCommandWithTimeout, type CommandOutcome } from './command'

const TAIL_LIMIT = 6000
const DEFAULT_DIR = '.agent/snapshot'
const AGENT_DIR = '.agent'
const MODULE_DIR = 'node_modules'

export interface SnapshotStep {
  name: string
  command: string
  timeoutMs: number
}

const STEPS: SnapshotStep[] = [
  { name: 'lint', command: 'npm run lint', timeoutMs: 300_000 },
  { name: 'tsc', command: 'npx tsc --noEmit', timeoutMs: 300_000 },
  {
    name: 'test',
    command: 'node --import tsx --experimental-test-module-mocks --test tests/*.test.ts',
    timeoutMs: 900_000
  }
]

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function git(args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd: process.cwd(), encoding: 'utf-8' })
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  }
}

function parseArgs(argv: string[]): { dir: string } {
  let dir = DEFAULT_DIR

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--dir') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) fail('usage: npx tsx scripts/agent/snapshot.ts [--dir <name>]')
      dir = value
      index += 1
      continue
    }
    if (token.startsWith('--dir=')) {
      dir = token.slice('--dir='.length)
      continue
    }
    fail(`unknown argument: ${token}\nusage: npx tsx scripts/agent/snapshot.ts [--dir <name>]`)
  }

  return { dir }
}

function assertNoLinkedSnapshotPath(root: string, local: string): void {
  let ancestor = root
  const parts = local.split(/[\\/]/)
  for (let index = 0; index < parts.length; index += 1) {
    ancestor = join(ancestor, parts[index])
    const stat = lstatSync(ancestor, { throwIfNoEntry: false })
    if (stat?.isSymbolicLink()) {
      fail(`snapshot directory must not traverse a link: ${local}`)
    }
    if (stat && index < parts.length - 1 && !stat.isDirectory()) {
      fail(`snapshot path component is not a directory: ${ancestor}`)
    }
    if (stat && index === parts.length - 1 && !stat.isDirectory()) {
      fail(`snapshot directory is not a directory: ${ancestor}`)
    }
  }
}

/**
 * The snapshot directory must live inside the repository and must be ignored
 * by Git, so a check can never write tracked files by accident.
 */
function resolveSnapshotDir(dirArg: string): { absolute: string; relative: string } {
  const root = process.cwd()
  const bare = !/[\\/]/.test(dirArg) && !dirArg.startsWith('.')
  const absolute = bare ? resolve(root, AGENT_DIR, dirArg) : resolve(root, dirArg)
  const local = relative(root, absolute)

  if (!local || local.startsWith('..') || isAbsolute(local)) {
    fail(`snapshot directory must stay inside the repository: ${dirArg}`)
  }
  if (local === AGENT_DIR || relative(absolute, resolve(root, AGENT_DIR)) === '') {
    fail(`refusing to use the agent runtime directory itself: ${local}`)
  }

  assertNoLinkedSnapshotPath(root, local)

  const ignored = git(['check-ignore', '-q', '--', local])
  if (ignored.code !== 0) {
    fail(`snapshot directory must be ignored by Git: ${local}\nadd it to .gitignore or pass a path under ${AGENT_DIR}/`)
  }

  return { absolute, relative: local }
}

/** Removes the previous snapshot contents; junctions and symlinks are unlinked, never followed. */
function emptyDirectory(dir: string): void {
  const rootStat = lstatSync(dir, { throwIfNoEntry: false })
  if (!rootStat) return
  if (rootStat.isSymbolicLink()) {
    fail(`refusing to empty a snapshot directory that is a link: ${dir}`)
  }
  if (!rootStat.isDirectory()) {
    fail(`refusing to empty a snapshot path that is not a directory: ${dir}`)
  }
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (lstatSync(full).isSymbolicLink()) {
      unlinkSync(full)
      continue
    }
    rmSync(full, { recursive: true, force: true })
  }
}

function exportIndex(snapshotDir: string): void {
  const prefix = `${snapshotDir.replace(/\\/g, '/')}/`
  const result = git(['checkout-index', '--all', '-f', `--prefix=${prefix}`])
  if (result.code !== 0) {
    fail(`git checkout-index failed: ${result.stderr.trim() || result.stdout.trim()}`)
  }
}

function linkNodeModules(snapshotDir: string): string {
  const target = join(snapshotDir, MODULE_DIR)
  if (existsSync(target)) return `reused ${MODULE_DIR}`

  const source = join(process.cwd(), MODULE_DIR)
  if (!existsSync(source)) {
    fail(`${MODULE_DIR} is missing in the working tree; run npm ci before checking a snapshot`)
  }

  const type = process.platform === 'win32' ? 'junction' : 'dir'
  symlinkSync(source, target, type)
  return `${type} -> ${source}`
}

export function runSnapshotStep(
  step: SnapshotStep,
  cwd: string,
  env?: NodeJS.ProcessEnv
): Promise<CommandOutcome> {
  return runCommandWithTimeout({ command: step.command, cwd, timeoutMs: step.timeoutMs, env })
}

function countMatches(output: string, pattern: RegExp): number {
  const matches = output.match(pattern)
  return matches ? matches.length : 0
}

function summarizeLint(output: string): string {
  const errors = countMatches(output, /(^|\s)Error:/gm)
  const warnings = countMatches(output, /(^|\s)Warning:/gm)
  if (/No ESLint warnings or errors/i.test(output)) return 'no eslint warnings or errors'
  if (errors === 0 && warnings === 0) return 'no findings detected'
  return `${errors} error(s), ${warnings} warning(s)`
}

function summarizeTsc(output: string): string {
  const errors = countMatches(output, /error TS\d+/g)
  return errors ? `${errors} type error(s)` : 'no type errors'
}

function summarizeTests(output: string): string {
  const pass = output.match(/^(?:#|ℹ) pass (\d+)/m)
  const fail = output.match(/^(?:#|ℹ) fail (\d+)/m)
  const skipped = output.match(/^(?:#|ℹ) skipped (\d+)/m)
  const tests = output.match(/^(?:#|ℹ) tests (\d+)/m)
  if (!pass && !fail) return 'no TAP summary found'
  return [
    `${pass?.[1] ?? 0} pass`,
    `${fail?.[1] ?? 0} fail`,
    `${skipped?.[1] ?? 0} skipped`,
    `${tests?.[1] ?? 0} total`
  ].join(', ')
}

function summarizeStep(step: SnapshotStep, output: string): string {
  if (step.name === 'lint') return summarizeLint(output)
  if (step.name === 'tsc') return summarizeTsc(output)
  return summarizeTests(output)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const target = resolveSnapshotDir(args.dir)
  const root = process.cwd()

  const head = git(['rev-parse', '--short', 'HEAD'])
  const staged = git(['diff', '--cached', '--name-only', 'HEAD'])
  const stagedFiles = staged.code === 0 ? staged.stdout.trim() : ''

  // Recheck immediately before cleanup in case a path component changed after
  // argument validation.
  assertNoLinkedSnapshotPath(root, target.relative)
  emptyDirectory(target.absolute)
  mkdirSync(target.absolute, { recursive: true })
  exportIndex(target.absolute)
  const link = linkNodeModules(target.absolute)

  console.log(`snapshot dir  ${target.relative}`)
  console.log(`index         ${head.stdout.trim() || 'unknown'}`)
  console.log(
    stagedFiles
      ? `staged        ${stagedFiles.split('\n').length} file(s) differ from HEAD and are part of this snapshot`
      : 'staged        none; the snapshot equals HEAD'
  )
  console.log(`${MODULE_DIR}      ${link}`)
  console.log('')

  const results: { name: string; command: string; exitCode: number | null; ok: boolean; durationMs: number; summary: string; output: string }[] = []

  for (const step of STEPS) {
    const outcome = await runSnapshotStep(step, target.absolute)
    const ok = outcome.exitCode === 0 && !outcome.timedOut
    const summary = outcome.timedOut ? `timed out after ${step.timeoutMs}ms` : summarizeStep(step, outcome.output)

    results.push({
      name: step.name,
      command: step.command,
      exitCode: outcome.exitCode,
      ok,
      durationMs: outcome.durationMs,
      summary,
      output: outcome.output
    })

    console.log(
      `  [${ok ? 'PASS' : 'FAIL'}] ${step.name.padEnd(6)} exit=${outcome.exitCode ?? 'null'}  ${summary}  (${outcome.durationMs}ms)`
    )
    if (!ok) {
      console.log(`         $ ${step.command}`)
      console.log(outcome.output.slice(-TAIL_LIMIT).split('\n').slice(-25).map((line) => `         ${line}`).join('\n'))
    }
  }

  const ok = results.every((result) => result.ok)
  console.log(ok ? 'SNAPSHOT GREEN' : 'SNAPSHOT RED')
  console.log(`snapshot kept at ${relative(root, target.absolute)} for inspection`)

  if (!ok) process.exit(1)
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
