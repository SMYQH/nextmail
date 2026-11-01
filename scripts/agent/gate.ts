import { existsSync } from 'fs'
import { join } from 'path'
import { runCommandWithTimeout, type CommandOutcome } from './command'
import type { GateResult, GateStepResult } from './types'

const TAIL_LIMIT = 6000

export interface GateStep {
  name: string
  command: string
  timeoutMs: number
  required: boolean
}

export function runGateStep(
  step: GateStep,
  cwd = process.cwd(),
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

function summarizeBrowser(output: string): string {
  const passed = output.match(/(\d+) passed/g)
  const failed = output.match(/(\d+) failed/g)
  const lastPassed = passed?.at(-1)?.match(/(\d+)/)?.[1] ?? '0'
  const lastFailed = failed?.at(-1)?.match(/(\d+)/)?.[1] ?? '0'
  if (!passed && !failed) return 'no playwright summary found'
  return `${lastPassed} passed, ${lastFailed} failed`
}

export interface GateOptions {
  includeBrowser?: boolean
  only?: string[]
}

export async function runGate(options: GateOptions = {}): Promise<GateResult> {
  const hasBrowserSuite = existsSync(join(process.cwd(), 'playwright.config.ts'))

  const steps: GateStep[] = [
    { name: 'lint', command: 'npm run lint', timeoutMs: 300_000, required: true },
    { name: 'tsc', command: 'npx tsc --noEmit', timeoutMs: 300_000, required: true },
    { name: 'test', command: 'npm test', timeoutMs: 900_000, required: true }
  ]

  if (hasBrowserSuite) {
    steps.push({
      name: 'browser',
      command: 'npm run test:browser',
      timeoutMs: 900_000,
      required: options.includeBrowser !== false
    })
  }

  const selected = options.only?.length
    ? steps.filter((step) => options.only?.includes(step.name))
    : steps

  const results: GateStepResult[] = []

  for (const step of selected) {
    const outcome = await runGateStep(step)
    const ok = outcome.exitCode === 0 && !outcome.timedOut

    let summary = ''
    if (step.name === 'lint') summary = summarizeLint(outcome.output)
    else if (step.name === 'tsc') summary = summarizeTsc(outcome.output)
    else if (step.name === 'test') summary = summarizeTests(outcome.output)
    else if (step.name === 'browser') summary = summarizeBrowser(outcome.output)

    results.push({
      name: step.name,
      command: step.command,
      exitCode: outcome.exitCode,
      ok,
      durationMs: outcome.durationMs,
      skipped: false,
      summary: outcome.timedOut ? `timed out after ${step.timeoutMs}ms` : summary,
      outputTail: outcome.output.slice(-TAIL_LIMIT)
    })
  }

  return {
    ok: results.every((result) => result.ok),
    ranAt: new Date().toISOString(),
    steps: results
  }
}
