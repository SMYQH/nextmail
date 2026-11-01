import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSnapshotEnv, buildSnapshotRuntimeEnv, emptyDirectory, localEnv, parseArgs, resolveSnapshotDir, run } from './browser/run-isolated.mjs'

test('isolated browser arguments preserve serial sharding and reject invalid selections', () => {
  assert.deepEqual(parseArgs(['--port', '3118', '--dir', 'browser-check', '--shard', '2/4']), {
    port: 3118, dir: 'browser-check', warmup: true, shard: '2/4', playwrightArgs: [],
  })
  assert.equal(parseArgs(['--shard=1/3']).shard, '1/3')
  assert.deepEqual(parseArgs(['--grep', 'session', '--project', 'desktop-chromium']).playwrightArgs,
    ['--grep', 'session', '--project', 'desktop-chromium'])
  assert.throws(() => parseArgs(['--grep']), /requires a value/)
  assert.throws(() => parseArgs(['--project', 'msedge']), /bundled Chromium/)
  for (const shard of ['0/3', '4/3', '1/0', '1', '1/2x', '1/9007199254740992']) {
    assert.throws(() => parseArgs([`--shard=${shard}`]), /--shard/)
  }
  assert.throws(() => parseArgs(['--port', '3000']), /must not use port 3000/)
  assert.throws(() => parseArgs(['--port', '65536']), /valid TCP port/)
})

test('isolated browser children do not regain credentials or deployment seed settings from the parent', t => {
  const keys = [
    'CLOUDFLARE_API_TOKEN', 'cloudflare_api_key', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID',
    'CF_API_TOKEN', 'CF_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'REPOSITORY_URL', 'OPENAPI_WAF_VERIFY_SECRET',
    'AUTH_SECRET', 'AUTH_GITHUB_ID', 'AUTH_GITHUB_SECRET', 'AUTH_GOOGLE_ID', 'AUTH_GOOGLE_SECRET',
    'PLAYWRIGHT_BASE_URL', 'DATABASE_ID', 'KV_NAMESPACE_ID', 'CUSTOM_DOMAIN', 'EMAIL_DOMAIN',
    'DEFAULT_ROLE', 'EMAIL_DOMAINS', 'ADMIN_CONTACT', 'MAX_EMAILS', 'TURNSTILE_ENABLED',
    'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'CATCHALL_EMAIL', 'RESEND_CONFIG', 'EMAIL_ROLE_LIMITS',
    'ADMIN_USERS', 'CATCHALL_OWNER_USERNAME', 'NEXTMAIL_DEPLOY_DEFAULT_ROLE',
  ]
  const previous = keys.map(key => process.env[key])
  t.after(() => keys.forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key]
    else process.env[key] = previous[index]
  }))
  for (const key of keys) process.env[key] = 'isolation-regression-sentinel'
  const env = localEnv({ PLAYWRIGHT_PORT: '3118' })
  const child = run(process.execPath, ['-e', `
    const keys = ${JSON.stringify(keys)};
    process.stdout.write(JSON.stringify({
      absent: keys.every(key => process.env[key] === undefined),
      port: process.env.PLAYWRIGHT_PORT
    }));
  `], { capture: true, env })
  assert.equal(child.code, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout), { absent: true, port: '3118' })
})

test('snapshot cleanup is confined below results and preserves result siblings', t => {
  for (const path of ['.test/results', '.test/results/snapshots', '.test', '.wrangler', '.next', '.', '../outside']) {
    assert.throws(() => resolveSnapshotDir(path), /snapshot directory|results root/)
  }
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const parent = join(root, '.test', 'results', 'snapshots')
  mkdirSync(parent, { recursive: true })
  const fixture = mkdtempSync(join(parent, 'isolation-path-'))
  t.after(() => rmSync(fixture, { recursive: true, force: true }))
  const snapshot = join(fixture, 'snapshot')
  mkdirSync(snapshot)
  const snapshotFile = join(snapshot, 'stale.txt')
  writeFileSync(snapshotFile, 'snapshot output', 'utf8')
  const reportSibling = join(fixture, 'report.html')
  writeFileSync(reportSibling, 'preserve report sibling', 'utf8')
  emptyDirectory(snapshot)
  assert.equal(readFileSync(reportSibling, 'utf8'), 'preserve report sibling')
  assert.equal(resolveSnapshotDir(snapshot).absolute, snapshot)
  assert.equal(existsSync(snapshotFile), false)

  const target = join(fixture, 'target')
  mkdirSync(target)
  const sentinel = join(target, 'keep.txt')
  writeFileSync(sentinel, 'preserve local data', 'utf8')
  const link = join(fixture, 'linked')
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => resolveSnapshotDir(join(link, 'snapshot')), /must not traverse a link/)
  assert.equal(readFileSync(sentinel, 'utf8'), 'preserve local data')
})

test('snapshot environment uses fresh local authentication rather than repository secrets', () => {
  const snapshotSecret = 'a'.repeat(64)
  const first = buildSnapshotEnv(3118, snapshotSecret)
  const second = buildSnapshotEnv(3118)
  const runtime = buildSnapshotRuntimeEnv(3118, snapshotSecret)
  assert.notEqual(first, second)
  assert.equal(runtime.AUTH_SECRET, snapshotSecret)
  assert.equal(runtime.NEXT_PUBLIC_BASE_URL, 'http://localhost:3118')
  assert.equal(first.match(/^AUTH_SECRET="([^"]+)"/m)?.[1], runtime.AUTH_SECRET)
  assert.match(first, /^AUTH_SECRET="[a-f0-9]{64}"/)
  assert.match(first, /NEXT_PUBLIC_BASE_URL="http:\/\/localhost:3118"/)
  assert.match(first, /AUTH_GITHUB_SECRET=""/)
  assert.match(first, /AUTH_GOOGLE_SECRET=""/)
  assert.doesNotMatch(first, /CLOUDFLARE|GITHUB_TOKEN|isolation-regression-sentinel/)
})
