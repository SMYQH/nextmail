import { randomBytes } from "node:crypto"
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

const LOCAL_APP_SECRET_NAMES = [
  "AUTH_SECRET",
  "AUTH_GITHUB_ID",
  "AUTH_GITHUB_SECRET",
  "AUTH_GOOGLE_ID",
  "AUTH_GOOGLE_SECRET",
  "WEBHOOK_ALLOWED_HOSTS",
]

type WranglerConfig = {
  name?: string
  main?: string
  compatibility_date?: string
  compatibility_flags?: string[]
  workers_dev?: boolean
  assets?: { directory?: string; binding?: string }
  services?: Array<Record<string, unknown>>
  d1_databases?: Array<{
    binding?: string
    database_name?: string
    database_id?: string
    migrations_dir?: string
  }>
  kv_namespaces?: Array<{ binding?: string; id?: string }>
}

export type LocalWranglerConfig = {
  configPath: string
  proxyPersistPath: string
  wranglerPersistPath: string
  requiredSecrets: string[]
  cleanup: () => void
}

function assertInside(parent: string, path: string) {
  const fromParent = relative(parent, path)
  if (!fromParent || fromParent.startsWith("..") || isAbsolute(fromParent)) {
    throw new Error("Generated local Wrangler config escaped its ignored runtime directory.")
  }
}

function removeGeneratedConfigFiles(runtimeDirectory: string) {
  const configPath = resolve(runtimeDirectory, "wrangler.json")
  const persistenceLink = resolve(runtimeDirectory, ".wrangler/state")
  try { unlinkSync(configPath) } catch { /* preserve any unrelated files */ }
  try {
    if (lstatSync(persistenceLink).isSymbolicLink()) {
      if (process.platform === "win32") rmdirSync(persistenceLink)
      else unlinkSync(persistenceLink)
    }
  } catch { /* preserve any unrelated files */ }
  try { rmdirSync(dirname(persistenceLink)) } catch { /* preserve any sibling files */ }
  try { rmdirSync(runtimeDirectory) } catch { /* preserve any sibling files */ }
}

/**
 * Creates a short-lived local-only Wrangler config. It contains binding names
 * and IDs, but never copies process environment values into the file.
 */
export function createLocalWranglerConfig(
  root = process.cwd(),
  environment: Record<string, string | undefined> = process.env,
): LocalWranglerConfig {
  const projectRoot = resolve(root)
  const sourcePath = resolve(projectRoot, "wrangler.json")
  const source = JSON.parse(readFileSync(sourcePath, "utf8")) as WranglerConfig
  if (!source.main) throw new Error("wrangler.json is missing the Worker entrypoint.")

  const requiredSecrets = LOCAL_APP_SECRET_NAMES.filter(name => Boolean(environment[name]?.trim()))
  const localConfig = {
    name: source.name,
    main: resolve(projectRoot, source.main),
    ...(source.compatibility_date ? { compatibility_date: source.compatibility_date } : {}),
    ...(source.compatibility_flags ? { compatibility_flags: source.compatibility_flags } : {}),
    ...(source.workers_dev === undefined ? {} : { workers_dev: source.workers_dev }),
    ...(source.assets ? {
      assets: {
        ...source.assets,
        ...(source.assets.directory ? { directory: resolve(projectRoot, source.assets.directory) } : {}),
      },
    } : {}),
    ...(source.services ? { services: source.services } : {}),
    ...(source.d1_databases ? {
      d1_databases: source.d1_databases.map(database => ({
        ...database,
        ...(database.migrations_dir ? { migrations_dir: resolve(projectRoot, database.migrations_dir) } : {}),
      })),
    } : {}),
    ...(source.kv_namespaces ? { kv_namespaces: source.kv_namespaces } : {}),
    ...(requiredSecrets.length > 0 ? { secrets: { required: requiredSecrets } } : {}),
  }

  const outputDirectory = resolve(projectRoot, ".test/results/runtime-config")
  mkdirSync(outputDirectory, { recursive: true })
  const realProjectRoot = realpathSync(projectRoot)
  const realOutputDirectory = realpathSync(outputDirectory)
  assertInside(realProjectRoot, realOutputDirectory)

  const runtimeDirectory = resolve(outputDirectory, `runtime-${process.pid}-${randomBytes(6).toString("hex")}`)
  assertInside(realOutputDirectory, runtimeDirectory)
  mkdirSync(runtimeDirectory)
  assertInside(realOutputDirectory, realpathSync(runtimeDirectory))
  const configPath = resolve(runtimeDirectory, "wrangler.json")
  const sharedPersistencePath = resolve(projectRoot, ".wrangler/state")
  const proxyPersistenceLink = resolve(runtimeDirectory, ".wrangler/state")
  mkdirSync(sharedPersistencePath, { recursive: true })
  mkdirSync(dirname(proxyPersistenceLink), { recursive: true })

  try {
    symlinkSync(sharedPersistencePath, proxyPersistenceLink, process.platform === "win32" ? "junction" : "dir")
    writeFileSync(configPath, `${JSON.stringify(localConfig, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 })
  } catch (error) {
    try {
      assertInside(realOutputDirectory, realpathSync(runtimeDirectory))
      removeGeneratedConfigFiles(runtimeDirectory)
    } catch { /* retain the setup error */ }
    throw new Error("Could not prepare the ignored local Wrangler config and shared persistence link.", { cause: error })
  }

  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    try { assertInside(realOutputDirectory, realpathSync(runtimeDirectory)) } catch { return }
    removeGeneratedConfigFiles(runtimeDirectory)
  }
  process.once("exit", cleanup)

  return {
    configPath,
    proxyPersistPath: resolve(projectRoot, ".wrangler/state/v3"),
    wranglerPersistPath: sharedPersistencePath,
    requiredSecrets,
    cleanup,
  }
}
