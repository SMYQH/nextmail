import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { parse } from "dotenv"

export function assertSafeBuildEnv(root = process.cwd()) {
  const files = [".env", ".env.local", ...["production", "development", "test"].flatMap(mode => [`.env.${mode}`, `.env.${mode}.local`])]
  for (const file of files) {
    const path = resolve(root, file)
    if (!existsSync(path)) continue
    const values = parse(readFileSync(path))
    for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "GITHUB_TOKEN", "GH_TOKEN", "CF_API_TOKEN", "CF_API_KEY"]) {
      if (values[name]) throw new Error(`${file} contains deployment credential ${name}. Move deployment settings to .env.deploy before building; OpenNext bundles application .env files.`)
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) assertSafeBuildEnv()
