#!/usr/bin/env node
/**
 * Isolated browser check for an INDEX snapshot.
 *
 * This script exports the Git INDEX (not HEAD) into an ignored directory,
 * gives that snapshot its own local D1/KV and its own dev server port, and
 * runs the browser suite there. It never reuses the working tree's dev server
 * and never copies production credentials.
 *
 * What is checked is the content of the Git index. The index may contain
 * staged work that is not committed yet, so the script prints the list of
 * files that differ from HEAD. A result therefore describes the index, not the
 * committed tree, and the two must never be described interchangeably.
 *
 * Steps:
 *   1. Resolve the snapshot directory: it must be a child of the ignored
 *      `.test/results/snapshots` directory.
 *   2. Export the index with `git checkout-index` (the working tree is never
 *      touched).
 *   3. Refuse to continue when the exported `playwright.config.ts` differs
 *      from the working tree copy: the exported config is the one that gets
 *      exercised, and overwriting it would hide the checked content.
 *   4. Link `node_modules` and generate a snapshot-local `.env.deploy` with a fresh
 *      authentication secret and the snapshot port. No repository environment
 *      file is read and no value is printed.
 *   5. Generate the snapshot-local Wrangler config from the tracked
 *      template, apply the local D1 migrations inside the snapshot and seed
 *      the snapshot's local KV with the local-only values the repository
 *      bootstrap uses (read from the snapshot's own `scripts/bootstrap-local.mjs`).
 *   6. Warm the snapshot up: its own dev server is started once, the routes
 *      the suite drives are requested together with their client chunks, and
 *      the server is stopped again, so the suite does not race the compiler.
 *   7. Run Playwright inside the snapshot on its own port.
 *
 * Usage:
 *   node tests/browser/run-isolated.mjs [--port <port>] [--dir <snapshot dir>]
 *                                         [--skip-warmup] [--shard current/total]
 *                                         [--grep pattern] [--project project]
 *
 * Environment overrides:
 *   ISOLATED_BROWSER_PORT  port for the snapshot dev server (default 3111)
 *   ISOLATED_BROWSER_DIR   snapshot directory (default iso-browser)
 *
 * The snapshot lives under `.test/results/snapshots/`, which is ignored by Git, so the export
 * never shows up in `git status`.
 */

import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(scriptDir, '..', '..')
const SNAPSHOT_ROOT = '.test/results/snapshots'
const DEFAULT_DIR = 'iso-browser'
const DEFAULT_PORT = 3111

const isWindows = process.platform === 'win32'

/**
 * Cloudflare credentials must never reach a child of this script: the
 * snapshot only talks to local bindings. The rest of the environment is
 * inherited unchanged.
 */
const CLOUDFLARE_CREDENTIAL_VARS = [
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_API_KEY',
  'CLOUDFLARE_EMAIL',
  'CLOUDFLARE_API_EMAIL',
  'CLOUDFLARE_DASHBOARD_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_ZONE_ID',
  'CLOUDFLARE_ORG_ID',
  'WRANGLER_API_TOKEN',
  'WRANGLER_ACCOUNT_ID',
  'CF_API_TOKEN',
  'CF_API_KEY',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'REPOSITORY_URL',
  'DATABASE_ID',
  'KV_NAMESPACE_ID',
  'CUSTOM_DOMAIN',
  'EMAIL_DOMAIN',
  'OPENAPI_WAF_VERIFY_SECRET',
  'DEFAULT_ROLE',
  'EMAIL_DOMAINS',
  'ADMIN_CONTACT',
  'MAX_EMAILS',
  'TURNSTILE_ENABLED',
  'TURNSTILE_SITE_KEY',
  'TURNSTILE_SECRET_KEY',
  'CATCHALL_EMAIL',
  'RESEND_CONFIG',
  'EMAIL_ROLE_LIMITS',
  'ADMIN_USERS',
  'CATCHALL_OWNER_USERNAME',
  'NEXTMAIL_DEPLOY_DEFAULT_ROLE',
  'AUTH_SECRET',
  'AUTH_GITHUB_ID',
  'AUTH_GITHUB_SECRET',
  'AUTH_GOOGLE_ID',
  'AUTH_GOOGLE_SECRET',
  'WEBHOOK_ALLOWED_HOSTS',
  'NEXT_PUBLIC_BASE_URL',
  'PLAYWRIGHT_BASE_URL',
  'PLAYWRIGHT_PORT',
]

function fail(message) {
  throw new Error(`[isolated] ${message}`)
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf-8' })
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function parsePort(raw) {
  if (!/^\d+$/.test(raw.trim())) {
    fail(`--port must be a decimal TCP port, received "${raw}"`)
  }
  const port = Number(raw.trim())
  if (port <= 0 || port > 65535) {
    fail(`--port must be a valid TCP port, received "${raw}"`)
  }
  return port
}

export function parseArgs(argv) {
  let port = process.env.ISOLATED_BROWSER_PORT ? parsePort(process.env.ISOLATED_BROWSER_PORT) : DEFAULT_PORT
  let dir = process.env.ISOLATED_BROWSER_DIR ?? DEFAULT_DIR
  let warmup = true
  let shard
  const playwrightArgs = []

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--skip-warmup') {
      warmup = false
      continue
    }
    if (token === '--grep' || token === '--project') {
      const value = argv[++index]
      if (!value || value.startsWith('--')) fail(`${token} requires a value`)
      if (token === '--project' && !['desktop-chromium', 'mobile-chromium'].includes(value)) {
        fail('--project must select a bundled Chromium project')
      }
      playwrightArgs.push(token, value)
      continue
    }
    if (token === '--shard' || token.startsWith('--shard=')) {
      const value = token === '--shard' ? argv[++index] : token.slice('--shard='.length)
      const match = value?.match(/^(\d+)\/(\d+)$/)
      const current = Number(match?.[1])
      const total = Number(match?.[2])
      if (!Number.isSafeInteger(current) || !Number.isSafeInteger(total) || current < 1 || current > total) {
        fail('--shard must be current/total with 1 <= current <= total')
      }
      shard = `${current}/${total}`
      continue
    }
    if (token === '--port' || token === '--dir') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) {
        fail('usage: node tests/browser/run-isolated.mjs [--port <port>] [--dir <snapshot dir>] [--skip-warmup]')
      }
      if (token === '--port') port = parsePort(value)
      else dir = value
      index += 1
      continue
    }
    if (token.startsWith('--port=')) {
      port = parsePort(token.slice('--port='.length))
      continue
    }
    if (token.startsWith('--dir=')) {
      dir = token.slice('--dir='.length)
      continue
    }
    fail(`unknown argument: ${token}\nusage: node tests/browser/run-isolated.mjs [--port <port>] [--dir <snapshot dir>] [--skip-warmup]`)
  }

  if (port === 3000) {
    fail('the isolated run must not use port 3000, that is the working tree port.')
  }
  return { port, dir, warmup, shard, playwrightArgs }
}

/**
 * The snapshot directory must be a dedicated child of the ignored snapshots
 * root. Neither that root nor `.test/results` is ever emptied.
 */
export function resolveSnapshotDir(dirArg) {
  const bare = !/[\\/]/.test(dirArg) && !dirArg.startsWith('.')
  const snapshotRoot = resolve(ROOT, SNAPSHOT_ROOT)
  const absolute = bare ? resolve(snapshotRoot, dirArg) : resolve(ROOT, dirArg)
  const local = relative(ROOT, absolute)

  if (!local || local.startsWith('..') || isAbsolute(local)) {
    fail(`snapshot directory must stay inside ${SNAPSHOT_ROOT}: ${dirArg}`)
  }
  const snapshotRelative = relative(snapshotRoot, absolute)
  if (!snapshotRelative || snapshotRelative.startsWith('..') || isAbsolute(snapshotRelative)) {
    fail(`snapshot directory must be a child of ${SNAPSHOT_ROOT}; refusing to use the results root: ${local}`)
  }
  const parts = local.split(/[\\/]/)
  if (parts.includes('node_modules')) {
    fail(`refusing to use a directory inside node_modules: ${local}`)
  }
  let ancestor = ROOT
  for (const part of parts) {
    ancestor = join(ancestor, part)
    if (lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink()) {
      fail(`snapshot directory must not traverse a link: ${local}`)
    }
  }

  const ignored = git(['check-ignore', '-q', '--', local.replace(/\\/g, '/')])
  if (ignored.code !== 0) {
    fail(`snapshot directory must be ignored by Git: ${local}\nadd ${SNAPSHOT_ROOT}/ to .gitignore`)
  }

  return { absolute, relative: local }
}

/** Empties the previous snapshot contents; junctions and symlinks are unlinked, never followed. */
export function emptyDirectory(dir) {
  if (!existsSync(dir)) return
  // A linked snapshot root would delete whatever it points at.
  if (lstatSync(dir).isSymbolicLink()) {
    fail(`refusing to empty a snapshot directory that is a link: ${dir}`)
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

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    encoding: 'utf-8',
    shell: false,
    env: options.env ?? localEnv(),
    stdio: options.capture ? 'pipe' : 'inherit',
  })
  if (result.error) fail(`${command} failed to start: ${result.error.message}`)
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** Runs an npm CLI script without a shell, so Windows paths with spaces work. */
function npm(args, options = {}) {
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(npmCli)) {
    return run(process.execPath, [npmCli, ...args], options)
  }
  return run(isWindows ? 'npm.cmd' : 'npm', args, options)
}

/**
 * The environment for the local-only children: everything is inherited, but
 * no ambient Cloudflare credential can travel with it.
 */
export function localEnv(extra = {}) {
  const env = { ...process.env }
  const removed = []
  const excluded = new Set(CLOUDFLARE_CREDENTIAL_VARS.map(name => name.toUpperCase()))
  for (const name of Object.keys(env)) {
    if (excluded.has(name.toUpperCase())) {
      removed.push(name)
      delete env[name]
    }
  }
  if (removed.length > 0) {
    console.log(`[isolated] local-only children without ambient credentials: ${removed.join(', ')}`)
  }
  return { ...env, ...extra }
}

/**
 * Reads the local-only KV values from the snapshot's own bootstrap script, so
 * the snapshot is seeded with the same values the repository uses instead of
 * invented ones.
 */
function readBootstrapKvValues(snapshotDir) {
  const source = readFileSync(join(snapshotDir, 'scripts', 'bootstrap-local.mjs'), 'utf-8')

  const domain = source.match(/flags\.domain\s*===\s*'string'\s*\?\s*flags\.domain\s*:\s*'([^']+)'/)
  if (!domain) {
    fail("could not read the bootstrap email domain from scripts/bootstrap-local.mjs: expected a 'flags.domain' fallback like 'test.example.com'")
  }

  const role = source.match(/\[\s*'DEFAULT_ROLE'\s*,\s*'([^']+)'\s*\]/)
  if (!role) {
    fail("could not read the bootstrap default role from scripts/bootstrap-local.mjs: expected a kvWrites entry like ['DEFAULT_ROLE', 'duke']")
  }

  if (!/\[\s*'EMAIL_DOMAINS'\s*,\s*domain\s*\]/.test(source)) {
    fail("scripts/bootstrap-local.mjs no longer writes EMAIL_DOMAINS: expected a kvWrites entry like ['EMAIL_DOMAINS', domain]")
  }

  return { domain: domain[1], role: role[1] }
}

/** Generates local-only values without reading any repository environment file. */
export function buildSnapshotEnv(port, authSecret = randomBytes(32).toString('hex')) {
  return [
    `AUTH_SECRET="${authSecret}"`,
    'AUTH_GITHUB_ID=""',
    'AUTH_GITHUB_SECRET=""',
    'AUTH_GOOGLE_ID=""',
    'AUTH_GOOGLE_SECRET=""',
    `NEXT_PUBLIC_BASE_URL="http://localhost:${port}"`,
    'WEBHOOK_ALLOWED_HOSTS=""',
    '',
  ].join('\n')
}

/** Process settings for the snapshot's local workers when Actions skips dotenv files. */
export function buildSnapshotRuntimeEnv(port, authSecret) {
  return {
    AUTH_SECRET: authSecret,
    AUTH_GITHUB_ID: '',
    AUTH_GITHUB_SECRET: '',
    AUTH_GOOGLE_ID: '',
    AUTH_GOOGLE_SECRET: '',
    NEXT_PUBLIC_BASE_URL: `http://localhost:${port}`,
    WEBHOOK_ALLOWED_HOSTS: '',
  }
}

/** The routes the browser suite drives, for both locales. */
const WARMUP_ROUTES = [
  '/en/login', '/en/mailbox', '/en/profile',
  '/zh-CN/login', '/zh-CN/mailbox', '/zh-CN/profile',
]

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { signal: controller.signal, redirect: 'follow' })
  } finally {
    clearTimeout(timer)
  }
}

/** Stops the warm-up server and everything it spawned. */
function stopServer(child) {
  if (!child || child.exitCode !== null) return
  if (isWindows) {
    // `next dev` forks the real server, so the whole tree has to go.
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      // The server is already gone.
    }
  }
}

/** Waits until nothing answers on the port, so Playwright can start its own. */
async function waitForPortFree(port) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      await fetchWithTimeout(`http://127.0.0.1:${port}/en/login`, 3_000)
    } catch {
      return
    }
    await wait(500)
  }
  fail(`the warm-up server did not release port ${port}`)
}

/**
 * Warms the snapshot up before the suite runs.
 *
 * A cold snapshot compiles the routes and their client chunks while the first
 * page loads, so the client session cannot resolve inside the expectation
 * budget. The snapshot's own dev server is started once, the routes the suite
 * drives are requested together with the client chunks they reference, and the
 * server is stopped again. The build cache is then warm and the suite no
 * longer races the compiler.
 *
 * The warm-up uses the snapshot's own directory, its own local D1/KV and the
 * snapshot's own port, and it never touches anything outside the snapshot
 * directory.
 */
async function warmUp(snapshotDir, port, runtimeEnv) {
  const base = `http://127.0.0.1:${port}`
  const nextBin = join(snapshotDir, 'node_modules', 'next', 'dist', 'bin', 'next')
  const envPreloader = join(snapshotDir, 'scripts', 'deploy', 'preload-app-env.ts')
  const child = spawn(process.execPath, ['--import', 'tsx', '--import', envPreloader, nextBin, 'dev'], {
    cwd: snapshotDir,
    env: localEnv({ ...runtimeEnv, PORT: String(port) }),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !isWindows,
  })
  let diagnostics = ''
  child.stdout.on('data', chunk => { diagnostics += chunk.toString() })
  child.stderr.on('data', chunk => { diagnostics += chunk.toString() })

  try {
    const deadline = Date.now() + 240_000
    let ready = false
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        fail(`the warm-up server exited with code ${child.exitCode}\n${diagnostics.slice(-2000)}`)
      }
      try {
        await fetchWithTimeout(`${base}/en/login`, 20_000)
        ready = true
        break
      } catch {
        await wait(1_000)
      }
    }
    if (!ready) fail(`the warm-up server did not answer within the budget\n${diagnostics.slice(-2000)}`)
    console.log('[isolated] warm-up server is answering')

    const chunks = new Set()
    for (const route of WARMUP_ROUTES) {
      const response = await fetchWithTimeout(`${base}${route}`, 180_000)
      const html = await response.text()
      for (const match of html.matchAll(/src="(\/_next\/static\/chunks\/[^"]+\.js)"/g)) chunks.add(match[1])
      console.log(`[isolated] warm-up ${route} -> ${response.status}`)
    }
    for (const chunk of chunks) {
      await fetchWithTimeout(`${base}${chunk}`, 180_000)
    }
    console.log(`[isolated] warm-up fetched ${chunks.size} client chunk(s)`)
  } finally {
    stopServer(child)
    await waitForPortFree(port)
    console.log(`[isolated] warm-up server stopped, port ${port} is free`)
  }
}

async function main() {
const args = parseArgs(process.argv.slice(2))
const target = resolveSnapshotDir(args.dir)
const SNAPSHOT = target.absolute

const head = git(['rev-parse', '--short', 'HEAD'])
const staged = git(['diff', '--cached', '--name-only', 'HEAD'])
const stagedFiles = staged.code === 0 ? staged.stdout.trim() : ''

console.log(`[isolated] snapshot dir  ${target.relative}`)
console.log(`[isolated] HEAD           ${head.stdout.trim() || 'unknown'}`)
console.log('[isolated] source         the Git index (not HEAD)')
if (stagedFiles) {
  console.log(`[isolated] staged         ${stagedFiles.split('\n').length} file(s) differ from HEAD and are part of this snapshot:`)
  for (const file of stagedFiles.split('\n')) console.log(`[isolated]                  - ${file}`)
} else {
  console.log('[isolated] staged         none; the snapshot equals HEAD')
}

emptyDirectory(SNAPSHOT)
mkdirSync(SNAPSHOT, { recursive: true })

const prefix = `${target.relative.replace(/\\/g, '/')}/`
const exported = git(['checkout-index', '--all', '-f', `--prefix=${prefix}`])
if (exported.code !== 0) {
  fail(`git checkout-index failed: ${exported.stderr.trim() || exported.stdout.trim()}`)
}
console.log(`[isolated] exported the index into ${target.relative}`)

for (const required of ['package.json', 'playwright.config.ts', 'wrangler.example.json', 'drizzle', 'tests/browser']) {
  if (!existsSync(join(SNAPSHOT, required))) {
    fail(`the snapshot export is incomplete, missing: ${required}`)
  }
}

// The exported config is the one that gets exercised. Overwriting it with the
// working tree copy would hide the checked content, so a difference is fatal.
const exportedConfig = join(SNAPSHOT, 'playwright.config.ts')
const workingConfig = join(ROOT, 'playwright.config.ts')
if (readFileSync(exportedConfig, 'utf-8') !== readFileSync(workingConfig, 'utf-8')) {
  fail(
    'the exported playwright.config.ts differs from the working tree copy.\n' +
      'The snapshot exercises the exported config, and it must not be overwritten.\n' +
      'Stage the isolation-aware config (git add playwright.config.ts) so the index carries it,\n' +
      'or commit it, and run this script again.',
  )
}
console.log('[isolated] exported playwright.config.ts matches the working tree copy')

const nodeModulesTarget = join(ROOT, 'node_modules')
const nodeModulesLink = join(SNAPSHOT, 'node_modules')
if (!existsSync(nodeModulesTarget)) {
  fail('node_modules is missing in the repository; run npm ci first.')
}
symlinkSync(nodeModulesTarget, nodeModulesLink, isWindows ? 'junction' : 'dir')

const snapshotAuthSecret = randomBytes(32).toString('hex')
const snapshotRuntimeEnv = buildSnapshotRuntimeEnv(args.port, snapshotAuthSecret)
const snapshotEnv = buildSnapshotEnv(args.port, snapshotAuthSecret)
const snapshotEnvPath = join(SNAPSHOT, '.env.deploy')
const envChanged = !existsSync(snapshotEnvPath) || readFileSync(snapshotEnvPath, 'utf-8') !== snapshotEnv
writeFileSync(snapshotEnvPath, snapshotEnv, { encoding: 'utf-8', mode: 0o600 })
console.log(`[isolated] node_modules linked, snapshot .env.deploy written (NEXT_PUBLIC_BASE_URL uses port ${args.port}; values never printed)`)

if (envChanged) {
  // NEXT_PUBLIC_* values are inlined while the client bundles are compiled, so
  // a changed .env.deploy needs a fresh build directory.
  rmSync(join(SNAPSHOT, '.next'), { recursive: true, force: true })
  console.log('[isolated] removed the stale build directory so the new public base URL is compiled in')
}

// The tracked Wrangler template is exported with the index. The local config
// that the snapshot uses is generated from it and never leaves the snapshot.
const generate = npm(['run', 'config:wrangler'], { cwd: SNAPSHOT, capture: true, env: localEnv() })
if (generate.code !== 0) {
  console.error(generate.stdout.slice(-2000))
  console.error(generate.stderr.slice(-2000))
  fail('the local Wrangler config could not be generated inside the snapshot.')
}
console.log('[isolated] local Wrangler config generated inside the snapshot')

const migrate = npm(['run', 'db:migrate-local'], { cwd: SNAPSHOT, capture: true, env: localEnv() })
if (migrate.code !== 0) {
  console.error(migrate.stdout.slice(-2000))
  console.error(migrate.stderr.slice(-2000))
  fail('the local migrations failed inside the snapshot.')
}
console.log('[isolated] local D1 migrations applied inside the snapshot')

const { domain, role } = readBootstrapKvValues(SNAPSHOT)
const wrangler = join(SNAPSHOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const kvState = join(SNAPSHOT, '.wrangler', 'state')
for (const [key, value] of [['EMAIL_DOMAINS', domain], ['DEFAULT_ROLE', role]]) {
  const kv = run(
    process.execPath,
    [wrangler, 'kv', 'key', 'put', key, value, '--binding', 'SITE_CONFIG', '--local', '--persist-to', kvState],
    { cwd: SNAPSHOT, capture: true, env: localEnv() },
  )
  if (kv.code !== 0) {
    console.error(kv.stdout.slice(-2000))
    console.error(kv.stderr.slice(-2000))
    fail(`writing the local KV key ${key} failed.`)
  }
  console.log(`[isolated] local KV ${key} written`)
}

const cli = join(SNAPSHOT, 'node_modules', '@playwright', 'test', 'cli.js')
if (args.warmup) {
  console.log(`[isolated] warming the snapshot up on port ${args.port}`)
  await warmUp(SNAPSHOT, args.port, snapshotRuntimeEnv)
}
console.log(`[isolated] running the browser suite in the snapshot on port ${args.port}`)
const test = run(process.execPath, [cli, 'test', '--max-failures=1', ...args.playwrightArgs, ...(args.shard ? [`--shard=${args.shard}`] : [])], {
  cwd: SNAPSHOT,
  env: localEnv({ ...snapshotRuntimeEnv, PLAYWRIGHT_PORT: String(args.port) }),
})

console.log(`[isolated] Playwright exited with code ${test.code}`)
const d1State = join(SNAPSHOT, '.wrangler', 'state', 'v3', 'd1')
const kvDir = join(SNAPSHOT, '.wrangler', 'state', 'v3', 'kv')
console.log(`[isolated] snapshot D1 state: ${existsSync(d1State) ? d1State : 'missing'}`)
console.log(`[isolated] snapshot KV state: ${existsSync(kvDir) ? kvDir : 'missing'}`)
const nextDir = join(SNAPSHOT, '.next')
if (existsSync(nextDir)) {
  console.log(`[isolated] snapshot build dir: ${nextDir} (mtime ${statSync(nextDir).mtime.toISOString()})`)
}
process.exitCode = test.code
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
