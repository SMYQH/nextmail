#!/usr/bin/env node

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'dotenv'

const NEXT_ENV_FILES = new Set([
  '.env',
  '.env.local',
  '.env.development',
  '.env.development.local',
  '.env.production',
  '.env.production.local',
  '.env.test',
  '.env.test.local',
])

function legacyEnvFileNames(root) {
  return readdirSync(root)
    .filter(name =>
      NEXT_ENV_FILES.has(name) ||
      (name.startsWith('.env.') && name !== '.env.deploy' && name !== '.env.deploy.example') ||
      /^\.dev\.vars(?:\..+)?$/.test(name),
    )
    .sort()
}

function assignmentCount(contents, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${escaped}[ \\t]*=`, 'gm')
  return [...contents.matchAll(pattern)].length
}

function replaceOrAppend(contents, name, value) {
  const count = assignmentCount(contents, name)
  if (count > 1) throw new Error(`Duplicate ${name} entries in .env.deploy; resolve the variable manually.`)
  const entry = `${name}=${JSON.stringify(value)}`
  if (count === 0) {
    const separator = contents.length === 0 || /[\r\n]$/.test(contents) ? '' : '\n'
    return `${contents}${separator}${entry}\n`
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return contents.replace(new RegExp(`^[ \\t]*(?:export[ \\t]+)?${escaped}[ \\t]*=.*$`, 'm'), entry)
}

function writeAtomically(path, contents) {
  const temporaryPath = join(dirname(path), `.env.deploy.migrate-${process.pid}-${randomBytes(6).toString('hex')}.tmp`)
  writeFileSync(temporaryPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  try {
    renameSync(temporaryPath, path)
  } catch (error) {
    try { unlinkSync(temporaryPath) } catch { /* retain the original error */ }
    throw error
  }
}

function defaultBackupRoot() {
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'NextMail', 'config-backups')
  }
  const stateRoot = process.env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state')
  return join(stateRoot, 'nextmail', 'config-backups')
}

function assertOutsideProject(projectRoot, path) {
  const pathFromProject = relative(projectRoot, path)
  if (!pathFromProject || (!pathFromProject.startsWith('..') && !isAbsolute(pathFromProject))) {
    throw new Error('Local configuration backups must be outside the repository.')
  }
}

function preserveLegacyFiles(projectRoot, legacyFiles, backupRoot) {
  assertOutsideProject(projectRoot, backupRoot)
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 })

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  let backupDirectory
  let created = false
  for (let attempt = 0; attempt < 3; attempt += 1) {
    backupDirectory = join(backupRoot, `nextmail-${timestamp}-${randomBytes(6).toString('hex')}`)
    try {
      mkdirSync(backupDirectory, { mode: 0o700 })
      created = true
      break
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') continue
      throw new Error('Could not create an external backup directory for legacy environment files.')
    }
  }
  if (!backupDirectory || !created) {
    throw new Error('Could not reserve an external backup directory for legacy environment files.')
  }

  const backups = []
  try {
    for (const name of legacyFiles) {
      const originalPath = join(projectRoot, name)
      const backupPath = join(backupDirectory, name)
      const original = readFileSync(originalPath)
      writeFileSync(backupPath, original, { flag: 'wx', mode: 0o600 })
      if (!readFileSync(backupPath).equals(original)) {
        throw new Error('Backup verification failed.')
      }
      backups.push({ name, originalPath, backupPath })
    }
  } catch {
    const backupFromRoot = relative(backupRoot, backupDirectory)
    if (backupFromRoot && !backupFromRoot.startsWith('..') && !isAbsolute(backupFromRoot)) {
      rmSync(backupDirectory, { recursive: true, force: true })
    }
    throw new Error(`Could not verify legacy environment backups in ${backupDirectory}; original files remain in place.`)
  }

  return { backupDirectory, backups }
}

/**
 * Consolidates legacy local environment files into the ignored .env.deploy.
 * Existing .env.deploy entries win. Legacy files are backed up byte-for-byte
 * outside the repository before they are removed from active config paths.
 *
 * @param {string} root
 * @param {{ makeSecret?: () => string; backupRoot?: string }} options
 */
export function migrateLocalConfig(root = process.cwd(), options = {}) {
  const projectRoot = resolve(root)
  const targetPath = join(projectRoot, '.env.deploy')
  const templatePath = join(projectRoot, '.env.deploy.example')
  const wasCreated = !existsSync(targetPath)

  let targetContents = ''
  if (wasCreated) {
    if (!existsSync(templatePath)) {
      throw new Error('Missing .env.deploy.example; create the local .env.deploy file before bootstrapping.')
    }
    targetContents = readFileSync(templatePath, 'utf8')
  } else {
    targetContents = readFileSync(targetPath, 'utf8')
  }

  const legacyFiles = legacyEnvFileNames(projectRoot)
  const targetValues = parse(targetContents)
  const sourceValues = new Map()
  const conflicts = new Set()
  const ambiguousMissingValues = new Set()

  for (const sourceName of legacyFiles) {
    const values = parse(readFileSync(join(projectRoot, sourceName)))
    for (const [name, value] of Object.entries(values)) {
      if (Object.hasOwn(targetValues, name)) {
        if (wasCreated && targetValues[name] === '' && value !== '') {
          sourceValues.set(name, value)
        } else if (targetValues[name] !== value) {
          conflicts.add(name)
        }
        continue
      }

      const previous = sourceValues.get(name)
      if (previous !== undefined && previous !== value) {
        ambiguousMissingValues.add(name)
      } else {
        sourceValues.set(name, value)
      }
    }
  }

  if (ambiguousMissingValues.size > 0) {
    const names = [...ambiguousMissingValues].sort().join(', ')
    throw new Error(`Legacy files disagree on variables missing from .env.deploy: ${names}. Resolve those names before migration.`)
  }

  for (const name of sourceValues.keys()) {
    if (assignmentCount(targetContents, name) > 1) {
      throw new Error(`Duplicate ${name} entries in .env.deploy; resolve the variable manually.`)
    }
  }

  for (const [name, value] of sourceValues) {
    targetContents = replaceOrAppend(targetContents, name, value)
  }

  let targetValuesAfterMerge = parse(targetContents)
  let generatedAuthSecret = false
  if (!targetValuesAfterMerge.AUTH_SECRET?.trim()) {
    const makeSecret = options.makeSecret ?? (() => randomBytes(32).toString('hex'))
    targetContents = replaceOrAppend(targetContents, 'AUTH_SECRET', makeSecret())
    generatedAuthSecret = true
  }

  let preserved
  if (legacyFiles.length > 0) {
    const backupRoot = resolve(options.backupRoot ?? defaultBackupRoot())
    preserved = preserveLegacyFiles(projectRoot, legacyFiles, backupRoot)
  }

  try {
    if (wasCreated || targetContents !== (existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : '')) {
      writeAtomically(targetPath, targetContents)
    }
  } catch (error) {
    const backupNote = preserved ? ` Legacy files are preserved at ${preserved.backupDirectory}.` : ''
    throw new Error(`Could not update .env.deploy.${backupNote}`, { cause: error })
  }

  const removalFailures = []
  for (const { name, originalPath } of preserved?.backups ?? []) {
    try {
      unlinkSync(originalPath)
    } catch {
      removalFailures.push(name)
    }
  }
  if (removalFailures.length > 0) {
    throw new Error(
      `Legacy files remain active after verified backup at ${preserved?.backupDirectory}: ${removalFailures.join(', ')}`,
    )
  }

  return {
    legacyFiles,
    backupDirectory: preserved?.backupDirectory,
    conflicts: [...conflicts].sort(),
    generatedAuthSecret,
    addedVariables: [...sourceValues.keys()].sort(),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = migrateLocalConfig()
    console.log('Local configuration uses ignored .env.deploy.')
    if (result.legacyFiles.length > 0) {
      console.log(`Preserved legacy files byte-for-byte outside the repository: ${result.backupDirectory} (${result.legacyFiles.join(', ')})`)
    }
    if (result.conflicts.length > 0) {
      console.log(`Existing .env.deploy values remain active for: ${result.conflicts.join(', ')}`)
    }
    if (result.addedVariables.length > 0) {
      console.log(`Copied legacy variables to .env.deploy: ${result.addedVariables.join(', ')}`)
    }
    if (result.generatedAuthSecret) {
      console.log('Generated a local AUTH_SECRET in .env.deploy.')
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Local configuration migration failed.')
    process.exitCode = 1
  }
}
