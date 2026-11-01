import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { parse } from "dotenv"

export const DATABASE_ID_PLACEHOLDER = "__DATABASE_ID__"
export const KV_NAMESPACE_ID_PLACEHOLDER = "__KV_NAMESPACE_ID__"

export type WranglerRoute = { pattern?: string; zone_name?: string; custom_domain?: boolean }

export type WranglerConfig = {
  workers_dev?: boolean
  routes?: WranglerRoute[]
  d1_databases?: Array<{ binding?: string; database_name?: string; database_id?: string }>
  kv_namespaces?: Array<{ binding?: string; id?: string }>
  [key: string]: unknown
}

export type WranglerConfigFile = {
  template: string
  output: string
  customDomain: boolean
}

/**
 * The tracked templates hold the Worker structure. The generated files are
 * ignored and carry the resolved D1 and KV bindings of the local deployment.
 */
export const WRANGLER_CONFIG_FILES: WranglerConfigFile[] = [
  { template: "wrangler.example.json", output: "wrangler.json", customDomain: true },
  { template: "wrangler.email.example.json", output: "wrangler.email.json", customDomain: false },
  { template: "wrangler.cleanup.example.json", output: "wrangler.cleanup.json", customDomain: false },
]

type DeploymentEnvironment = Record<string, string | undefined>

export type ResolvedBindings = {
  databaseId: string
  kvNamespaceId: string
  route?: WranglerRoute
}

export type GeneratedWranglerConfigs = {
  written: string[]
  bindings: ResolvedBindings
}

function readRequiredConfig(path: string, label: string): WranglerConfig {
  if (!existsSync(path)) {
    throw new Error(`Missing ${label}. Restore the tracked template and run the command from the project root.`)
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as WranglerConfig
  } catch (error) {
    throw new Error(`Could not parse ${label}.`, { cause: error })
  }
}

function readGeneratedConfig(path: string): WranglerConfig | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, "utf8")) as WranglerConfig
  } catch (error) {
    throw new Error(`Could not parse the generated ${path}. Remove or repair it and run the command again.`, { cause: error })
  }
}

/**
 * Reads the ignored deployment file. It never overrides an explicit process
 * value, and CI must not read a local file as a fallback.
 */
function readDeployEnvironment(root: string, environment: DeploymentEnvironment): DeploymentEnvironment {
  const merged: DeploymentEnvironment = {}
  if (environment.GITHUB_ACTIONS !== "true") {
    const path = resolve(root, ".env.deploy")
    if (existsSync(path)) Object.assign(merged, parse(readFileSync(path, "utf8")))
  }
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined) merged[name] = value
  }
  return merged
}

/**
 * Resolves the Zone of a site host. A host that sits below the mail Zone uses
 * that Zone; every other host is treated as one label below its own Zone.
 */
export function resolveZoneName(hostname: string, emailDomain?: string): string {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "")
  const email = emailDomain?.trim().toLowerCase()
  if (email && (host === email || host.endsWith(`.${email}`))) return email
  const labels = host.split(".")
  if (labels.length < 3) return host
  return labels.slice(1).join(".")
}

function resolveDatabaseId(environment: DeploymentEnvironment, generated?: WranglerConfig): string {
  const override = environment.DATABASE_ID?.trim()
  if (override) return override
  const current = generated?.d1_databases?.[0]?.database_id
  if (current && current !== DATABASE_ID_PLACEHOLDER) return current
  return DATABASE_ID_PLACEHOLDER
}

function resolveKvNamespaceId(environment: DeploymentEnvironment, generated?: WranglerConfig): string {
  const override = environment.KV_NAMESPACE_ID?.trim()
  if (override) return override
  const current = generated?.kv_namespaces?.find(namespace => namespace.binding === "SITE_CONFIG")?.id
  if (current && current !== KV_NAMESPACE_ID_PLACEHOLDER) return current
  return KV_NAMESPACE_ID_PLACEHOLDER
}

function resolveRoute(environment: DeploymentEnvironment, generated?: WranglerConfig): WranglerRoute | undefined {
  const customDomain = environment.CUSTOM_DOMAIN?.trim()
  const generatedRoutes = (generated?.routes ?? []).filter(route => route.pattern && route.zone_name)
  if (!customDomain) {
    const preserved = generatedRoutes[0]
    return preserved ? { ...preserved } : undefined
  }
  const matched = generatedRoutes.find(route => route.pattern!.toLowerCase() === customDomain.toLowerCase())
  return {
    pattern: customDomain,
    zone_name: matched?.zone_name ?? resolveZoneName(customDomain, environment.EMAIL_DOMAIN),
    custom_domain: true,
  }
}

/**
 * Builds one generated config. An existing generated file stays authoritative
 * for everything except the resolved bindings, so manual edits and the values
 * written by the deployment script survive regeneration.
 */
function buildConfig(
  template: WranglerConfig,
  generated: WranglerConfig | undefined,
  bindings: ResolvedBindings,
  customDomain: boolean,
): WranglerConfig {
  const config: WranglerConfig = generated ? { ...template, ...generated } : { ...template }
  if (config.d1_databases) {
    config.d1_databases = config.d1_databases.map(database => ({ ...database, database_id: bindings.databaseId }))
  }
  if (config.kv_namespaces) {
    config.kv_namespaces = config.kv_namespaces.map(namespace => ({ ...namespace, id: bindings.kvNamespaceId }))
  }
  // A generated file that already exists keeps the exposure chosen by the
  // deployment script. Only a fresh file derives the custom domain route.
  if (customDomain && !generated) {
    if (bindings.route) {
      config.routes = [bindings.route]
      config.workers_dev = false
    } else {
      delete config.routes
      config.workers_dev = true
    }
  }
  return config
}

/**
 * Generates the ignored Wrangler configs from the tracked templates and the
 * resolved deployment bindings.
 */
export function generateWranglerConfigs(
  root = process.cwd(),
  environment: DeploymentEnvironment = process.env,
): GeneratedWranglerConfigs {
  const projectRoot = resolve(root)
  const values = readDeployEnvironment(projectRoot, environment)
  const generatedMain = readGeneratedConfig(resolve(projectRoot, "wrangler.json"))
  const bindings: ResolvedBindings = {
    databaseId: resolveDatabaseId(values, generatedMain),
    kvNamespaceId: resolveKvNamespaceId(values, generatedMain),
    route: resolveRoute(values, generatedMain),
  }

  const written: string[] = []
  for (const file of WRANGLER_CONFIG_FILES) {
    const template = readRequiredConfig(resolve(projectRoot, file.template), `Wrangler template ${file.template}`)
    const generated = readGeneratedConfig(resolve(projectRoot, file.output))
    const config = buildConfig(template, generated, bindings, file.customDomain)
    const target = resolve(projectRoot, file.output)
    const content = JSON.stringify(config, null, 2)
    if (!existsSync(target) || readFileSync(target, "utf8") !== content) {
      writeFileSync(target, content, "utf8")
      written.push(file.output)
    }
  }

  return { written, bindings }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { written, bindings } = generateWranglerConfigs()
  console.log(written.length > 0
    ? `Generated local Wrangler configs: ${written.join(", ")}`
    : "Local Wrangler configs are up to date")
  if (bindings.databaseId === DATABASE_ID_PLACEHOLDER) {
    console.log("No DATABASE_ID is configured; the generated configs keep the placeholder database id.")
  }
  if (bindings.kvNamespaceId === KV_NAMESPACE_ID_PLACEHOLDER) {
    console.log("No KV_NAMESPACE_ID is configured; the generated configs keep the placeholder namespace id.")
  }
}
