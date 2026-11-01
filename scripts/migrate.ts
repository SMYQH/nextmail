import { readFileSync } from 'fs'
import { exec } from 'child_process'
import { promisify } from 'util'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import './deploy/load-env'
import { buildDefaultRoleBackfillSql } from '../app/lib/database-statements'

const execAsync = promisify(exec)

interface D1Database {
  binding: string
  database_name: string
  database_id: string
}

interface WranglerConfig {
  d1_databases: D1Database[]
  kv_namespaces?: { binding: string; id: string }[]
}

interface KVNamespace {
  id?: string
  title?: string
}

type MigrationExec = (
  command: string,
  options?: { maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>

interface RoleBackfillDependencies {
  exec?: MigrationExec
  getKVNamespace?: (id: string) => Promise<KVNamespace | null>
  expectedNamespaceTitle?: string
  appliedDefaultRole?: string
}

const executeCommand: MigrationExec = async (command, options) => {
  const { stdout, stderr } = await execAsync(command, { ...options, encoding: 'utf8' })
  return { stdout, stderr }
}

export async function migrate() {
  try {
    // Get command line arguments
    const args = process.argv.slice(2)
    const mode = args[0]

    if (!mode || !['local', 'remote'].includes(mode)) {
      console.error('Error: Please specify mode (local or remote)')
      process.exit(1)
    }

    // Read wrangler.json
    const wranglerPath = join(process.cwd(), 'wrangler.json')
    let wranglerContent: string

    try {
      wranglerContent = readFileSync(wranglerPath, 'utf-8')
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      console.error('Error: wrangler.json not found')
      process.exit(1)
    }

    // Parse wrangler.json
    const config = JSON.parse(wranglerContent) as WranglerConfig

    if (!config.d1_databases?.[0]?.database_name) {
      console.error('Error: Database name not found in wrangler.json')
      process.exit(1)
    }

    const dbName = config.d1_databases[0].database_name

    // Apply reviewed, committed migrations; never generate schema changes during deployment.

    // Applying migrations
    console.log(`Applying migrations to ${mode} database: ${dbName}`)
    await execAsync(`wrangler d1 migrations apply ${dbName} --${mode}`)

    // Accounts that never received a role are backfilled once, so the session
    // callback can resolve roles read-only afterwards.
    await backfillDefaultRoles(config, dbName, mode, {
      appliedDefaultRole: mode === 'remote' ? process.env.NEXTMAIL_DEPLOY_DEFAULT_ROLE || undefined : undefined,
    })

    console.log('Migration completed successfully!')
  } catch (error) {
    console.error('Migration failed:', error)
    process.exit(1)
  }
}

/**
 * Grants the site's configured default role to accounts that have none.
 *
 * The default role lives in the SITE_CONFIG KV namespace, so it is read from
 * there instead of being hard-coded. A missing or unreadable value leaves the
 * data untouched rather than guessing a role.
 */
export async function backfillDefaultRoles(
  config: WranglerConfig,
  dbName: string,
  mode: string,
  dependencies: RoleBackfillDependencies = {},
) {
  const execute = dependencies.exec ?? executeCommand
  const rawNamespaceIdOverride = process.env.KV_NAMESPACE_ID
  const namespaceIdOverride = rawNamespaceIdOverride?.trim()
  if (rawNamespaceIdOverride && !namespaceIdOverride) {
    throw new Error('KV_NAMESPACE_ID is empty; refusing to read DEFAULT_ROLE from an ambiguous namespace.')
  }

  let namespaceId: string | undefined
  if (mode === 'remote' && namespaceIdOverride) {
    let getKVNamespace = dependencies.getKVNamespace
    let expectedNamespaceTitle = dependencies.expectedNamespaceTitle
    if (!getKVNamespace || !expectedNamespaceTitle) {
      const cloudflare = await import('./deploy/cloudflare')
      getKVNamespace ??= cloudflare.getKVNamespace
      expectedNamespaceTitle ??= cloudflare.KV_NAMESPACE_NAME
    }

    let selectedNamespace: KVNamespace | null
    try {
      selectedNamespace = await getKVNamespace(namespaceIdOverride)
    } catch (error) {
      throw new Error(
        `KV_NAMESPACE_ID ${namespaceIdOverride} could not be resolved; refusing the default-role backfill.`,
        { cause: error },
      )
    }

    if (!selectedNamespace || selectedNamespace.id !== namespaceIdOverride) {
      throw new Error(`KV_NAMESPACE_ID ${namespaceIdOverride} was not found; refusing the default-role backfill.`)
    }
    if (selectedNamespace.title !== expectedNamespaceTitle) {
      throw new Error(
        `KV_NAMESPACE_ID does not point to the project namespace "${expectedNamespaceTitle}"; refusing the default-role backfill.`,
      )
    }

    namespaceId = namespaceIdOverride
  } else if (mode === 'local' && namespaceIdOverride) {
    console.log('ℹ️ Ignoring KV_NAMESPACE_ID for a local migration; using the local SITE_CONFIG binding')
  }

  const binding = config.kv_namespaces?.find(entry => entry.binding === 'SITE_CONFIG')
  if (!namespaceId && !binding) {
    console.log('ℹ️ No SITE_CONFIG KV namespace is configured; skipping the default-role backfill')
    return
  }

  const namespaceTarget = namespaceId
    ? `--namespace-id ${namespaceId}`
    : '--binding SITE_CONFIG'

  // Full deployment just wrote this validated value to the selected namespace.
  // Avoid using a stale KV read while that update propagates.
  let defaultRole = dependencies.appliedDefaultRole
  if (defaultRole === undefined) {
    try {
      const { stdout } = await execute(
        `wrangler kv key get DEFAULT_ROLE ${namespaceTarget} --${mode} --text`,
        { maxBuffer: 1024 * 1024 },
      )
      defaultRole = stdout.trim().toLowerCase()
    } catch {
      console.log('ℹ️ Could not read DEFAULT_ROLE from KV; skipping the default-role backfill')
      return
    }
  }

  if (!defaultRole) {
    console.log('ℹ️ No default role is configured; skipping the default-role backfill')
    return
  }

  let sql: string
  try {
    sql = buildDefaultRoleBackfillSql(defaultRole)
  } catch {
    console.log(`ℹ️ Unsupported default role "${defaultRole}"; skipping the default-role backfill`)
    return
  }

  console.log(`Checking the one-time default-role backfill for "${defaultRole}"`)
  await execute(`wrangler d1 execute ${dbName} --${mode} --command "${sql.replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migrate()
}
