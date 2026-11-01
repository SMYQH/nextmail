import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, extname, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { parse } from "dotenv"

const SENSITIVE_ENV_NAME = /(SECRET|TOKEN|PASSWORD|PRIVATE.?KEY|API.?KEY)/i
const SENSITIVE_JSON_FIELD = /^(?:secret|token|password|private.?key|api.?key)$/i
const SENSITIVE_JSON_SETTING_NAMES = new Set(["ADMIN_USERS", "RESEND_CONFIG"])
const TEXT_ARTIFACT_EXTENSIONS = new Set([".cjs", ".css", ".html", ".js", ".json", ".map", ".mjs", ".svg", ".txt", ".xml"])

type CredentialValue = { name: string; value: string }

function collectNestedCredentials(value: unknown, name: string, path: string[] = []): CredentialValue[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => collectNestedCredentials(entry, name, [...path, String(index)]))
  }
  if (!value || typeof value !== "object") return []

  return Object.entries(value).flatMap(([key, nested]) => {
    const nestedPath = [...path, key]
    const apiKeyValue = key === "key" && path.some(part => /^apiKeys$/i.test(part))
    if (typeof nested === "string" && (SENSITIVE_JSON_FIELD.test(key) || apiKeyValue)) {
      return [{ name: `${name}.${nestedPath.join(".")}`, value: nested }]
    }
    return collectNestedCredentials(nested, name, nestedPath)
  })
}

function getCredentialValues(root: string): CredentialValue[] {
  const envSources: Record<string, string | undefined>[] = [{ ...process.env }]
  const deployEnvPath = resolve(root, ".env.deploy")
  if (existsSync(deployEnvPath)) envSources.push(parse(readFileSync(deployEnvPath)))

  const credentials: CredentialValue[] = []
  for (const envValues of envSources) {
    for (const [name, value] of Object.entries(envValues)) {
      if (!value || name.startsWith("NEXT_PUBLIC_")) continue
      if (SENSITIVE_ENV_NAME.test(name)) credentials.push({ name, value })
      if (SENSITIVE_JSON_SETTING_NAMES.has(name)) {
        try {
          credentials.push(...collectNestedCredentials(JSON.parse(value), name))
        } catch {
          // Deployment config validation reports malformed JSON before any build.
        }
      }
    }
  }
  const unique = new Map(credentials.map(credential => [`${credential.name}\u0000${credential.value}`, credential]))
  return [...unique.values()]
}

function walkArtifactFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return walkArtifactFiles(path)
    return entry.isFile() ? [path] : []
  })
}

function assertNoBundledEnvFiles(root: string, outputRoot: string) {
  for (const path of walkArtifactFiles(outputRoot)) {
    const filename = basename(path).toLowerCase()
    if (filename === ".env" || filename.startsWith(".env.") || filename === ".dev.vars" || filename.startsWith(".dev.vars.")) {
      throw new Error(`Worker artifact contains an environment file: ${relative(root, path).replace(/\\/g, "/")}`)
    }
  }
}

function assertNoBundledCredentials(root: string, outputRoot: string) {
  const files = walkArtifactFiles(outputRoot)
  const credentials = getCredentialValues(root)
    // Real credentials are longer; skipping short values avoids matching common
    // strings such as `secret` in framework code or bundled source maps.
    .filter(({ value }) => value.length >= 8)
  for (const path of files) {
    if (!TEXT_ARTIFACT_EXTENSIONS.has(extname(path).toLowerCase())) continue
    const artifact = readFileSync(path)
    for (const { name, value } of credentials) {
      if (artifact.includes(Buffer.from(value, "utf8"))) {
        throw new Error(`Worker artifact contains configured credential ${name}: ${relative(root, path).replace(/\\/g, "/")}`)
      }
    }
  }
}

export function assertOpenNextBuild(root = process.cwd()) {
  const workerPath = resolve(root, ".open-next/worker.js")
  const assetsPath = resolve(root, ".open-next/assets")
  const wranglerPath = resolve(root, "wrangler.json")

  if (!existsSync(workerPath) || !statSync(workerPath).isFile()) {
    throw new Error("OpenNext worker entrypoint was not generated at .open-next/worker.js")
  }
  if (!existsSync(assetsPath) || !statSync(assetsPath).isDirectory()) {
    throw new Error("OpenNext static assets were not generated at .open-next/assets")
  }

  assertNoBundledEnvFiles(root, resolve(root, ".open-next"))
  assertNoBundledCredentials(root, resolve(root, ".open-next"))

  const config = JSON.parse(readFileSync(wranglerPath, "utf8")) as {
    main?: string
    assets?: { directory?: string; binding?: string }
    compatibility_flags?: string[]
    d1_databases?: Array<{ binding?: string }>
    kv_namespaces?: Array<{ binding?: string }>
  }

  if (config.main !== ".open-next/worker.js") {
    throw new Error(`Wrangler main must target .open-next/worker.js, got ${config.main ?? "<missing>"}`)
  }
  if (config.assets?.directory !== ".open-next/assets" || config.assets.binding !== "ASSETS") {
    throw new Error("Wrangler must bind .open-next/assets as ASSETS")
  }
  const flags = config.compatibility_flags ?? []
  for (const flag of ["nodejs_compat", "nodejs_compat_populate_process_env", "global_fetch_strictly_public"]) {
    if (!flags.includes(flag)) throw new Error(`Wrangler is missing required compatibility flag ${flag}`)
  }
  if (!config.d1_databases?.some(({ binding }) => binding === "DB")) {
    throw new Error("Wrangler is missing the DB D1 binding")
  }
  if (!config.kv_namespaces?.some(({ binding }) => binding === "SITE_CONFIG")) {
    throw new Error("Wrangler is missing the SITE_CONFIG KV binding")
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assertOpenNextBuild()
  console.log("Validated the OpenNext Worker, static assets, and runtime bindings")
}
