import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const require = createRequire(import.meta.url)
const loader = pathToFileURL(require.resolve('tsx/esm')).href
const cli = resolve(root, 'scripts/agent/snapshot.ts')

function repository(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), 'nextmail-agent-snapshot-repo-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  mkdirSync(join(cwd, '.agent'))
  writeFileSync(join(cwd, '.gitignore'), '.agent/\n')
  const initialized = spawnSync('git', ['init', '--quiet'], { cwd, encoding: 'utf8' })
  assert.equal(initialized.status, 0, initialized.stderr)
  return cwd
}

function externalSnapshot(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'nextmail-agent-snapshot-target-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const snapshot = join(directory, 'snapshot')
  mkdirSync(snapshot)
  const sentinel = join(snapshot, 'keep.txt')
  writeFileSync(sentinel, 'preserve outside data', 'utf8')
  return { directory, snapshot, sentinel }
}

function run(cwd: string, snapshotPath: string) {
  return spawnSync(process.execPath, ['--import', loader, cli, '--dir', relative(cwd, snapshotPath)], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
  })
}

function makeDirectoryLink(target: string, link: string) {
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

test('snapshot cleanup rejects a linked root without deleting its target', t => {
  const cwd = repository(t)
  const target = externalSnapshot(t)
  const link = join(cwd, '.agent', 'snapshot-link')
  makeDirectoryLink(target.snapshot, link)
  t.after(() => rmSync(link, { recursive: true, force: true }))

  const result = run(cwd, link)

  assert.equal(result.status, 1)
  assert.match(result.stderr, /must not traverse a link|snapshot directory that is a link/)
  assert.equal(readFileSync(target.sentinel, 'utf8'), 'preserve outside data')
})

test('snapshot cleanup rejects a linked ancestor without deleting its target', t => {
  const cwd = repository(t)
  const target = externalSnapshot(t)
  const link = join(cwd, '.agent', 'target-link')
  makeDirectoryLink(target.directory, link)
  t.after(() => rmSync(link, { recursive: true, force: true }))

  const result = run(cwd, join(link, 'snapshot'))

  assert.equal(result.status, 1)
  assert.match(result.stderr, /must not traverse a link/)
  assert.equal(readFileSync(target.sentinel, 'utf8'), 'preserve outside data')
})
