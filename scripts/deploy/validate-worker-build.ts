import { existsSync, readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

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
