import { spawn, type ChildProcess } from 'child_process'

export interface CommandOutcome {
  exitCode: number | null
  output: string
  durationMs: number
  timedOut: boolean
}

interface RunCommandOptions {
  command: string
  cwd: string
  timeoutMs: number
  env?: NodeJS.ProcessEnv
}

const OUTPUT_LIMIT = 400_000
const OUTPUT_RETAINED = 200_000
const TERMINATE_GRACE_MS = 250
const FINALIZE_AFTER_TIMEOUT_MS = 2_500
const TASKKILL_WAIT_MS = 1_000

function killProcessGroup(pid: number, signal: NodeJS.Signals, child: ChildProcess): void {
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // The process may have exited between the timeout and the signal.
    }
  }
}

function killChild(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal)
  } catch {
    // The process may have exited between the timeout and the signal.
  }
}

function killWindowsProcessTree(pid: number, child: ChildProcess, onComplete: () => void): void {
  let completed = false
  let fallbackTimer: NodeJS.Timeout | undefined
  const complete = () => {
    if (completed) return
    completed = true
    clearTimeout(fallbackTimer)
    onComplete()
  }

  let taskkill: ChildProcess
  try {
    taskkill = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    })
  } catch {
    killChild(child, 'SIGTERM')
    complete()
    return
  }

  taskkill.unref()
  fallbackTimer = setTimeout(() => {
    try {
      taskkill.kill()
    } catch {
      // The taskkill process may have exited already.
    }
    killChild(child, 'SIGTERM')
    complete()
  }, TASKKILL_WAIT_MS)
  fallbackTimer.unref()

  const fallback = () => {
    if (completed) return
    killChild(child, 'SIGTERM')
    complete()
  }

  taskkill.once('error', fallback)
  taskkill.once('close', (code) => {
    if (code !== 0) fallback()
    else complete()
  })
}

export function runCommandWithTimeout({ command, cwd, timeoutMs, env }: RunCommandOptions): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(command, {
      shell: true,
      detached: process.platform !== 'win32',
      cwd,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...env }
    })

    let output = ''
    let timedOut = false
    let settled = false
    let processClosed = false
    let closeCode: number | null = null
    let terminationComplete = true
    let timeoutError: string | undefined
    let timeoutTimer: NodeJS.Timeout | undefined
    let forceKillTimer: NodeJS.Timeout | undefined
    let finalizeTimer: NodeJS.Timeout | undefined

    const finish = (exitCode: number | null, errorMessage?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      clearTimeout(forceKillTimer)
      clearTimeout(finalizeTimer)
      if (timedOut) {
        child.stdin?.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
        child.unref()
      }
      resolve({
        exitCode,
        output: errorMessage === undefined ? output : `${output}\n${errorMessage}`,
        durationMs: Date.now() - started,
        timedOut
      })
    }

    const finishIfReady = () => {
      if (!processClosed || (timedOut && !terminationComplete)) return
      finish(closeCode, timeoutError)
    }

    const collect = (chunk: Buffer) => {
      output += chunk.toString('utf-8')
      if (output.length > OUTPUT_LIMIT) output = output.slice(-OUTPUT_RETAINED)
    }

    child.stdout.on('data', collect)
    child.stderr.on('data', collect)

    timeoutTimer = setTimeout(() => {
      timedOut = true
      terminationComplete = false
      if (child.pid !== undefined) {
        if (process.platform === 'win32') {
          killWindowsProcessTree(child.pid, child, () => {
            terminationComplete = true
            finishIfReady()
          })
        } else {
          killProcessGroup(child.pid, 'SIGTERM', child)
          forceKillTimer = setTimeout(() => {
            if (child.pid !== undefined) killProcessGroup(child.pid, 'SIGKILL', child)
            terminationComplete = true
            finishIfReady()
          }, TERMINATE_GRACE_MS)
        }
      } else {
        killChild(child, 'SIGTERM')
        terminationComplete = true
      }

      finalizeTimer = setTimeout(() => {
        if (!terminationComplete) {
          if (process.platform === 'win32') killChild(child, 'SIGTERM')
          else if (child.pid !== undefined) killProcessGroup(child.pid, 'SIGKILL', child)
          terminationComplete = true
        }
        child.stdin?.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
        child.unref()
        finish(child.exitCode, timeoutError)
      }, FINALIZE_AFTER_TIMEOUT_MS)
    }, timeoutMs)

    child.on('error', (error) => {
      if (!timedOut) finish(null, error.message)
      else timeoutError = error.message
    })
    child.on('close', (code) => {
      processClosed = true
      closeCode = code
      finishIfReady()
    })
  })
}
