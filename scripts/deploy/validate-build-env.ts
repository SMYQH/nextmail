import { existsSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const LEGACY_ENV_FILES = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.production",
  ".env.production.local",
  ".env.test",
  ".env.test.local",
  ".dev.vars",
]

export function getLegacyEnvFiles(root = process.cwd()) {
  const directoryEntries = readdirSync(root)
  const otherEnvFiles = directoryEntries.filter(file =>
    file.startsWith(".env.") && file !== ".env.deploy" && file !== ".env.deploy.example",
  )
  const environmentSpecificDevVars = directoryEntries.filter(file => /^\.dev\.vars\..+$/.test(file))
  return [...new Set([
    ...LEGACY_ENV_FILES.filter(file => existsSync(resolve(root, file))),
    ...otherEnvFiles,
    ...environmentSpecificDevVars,
  ])].sort()
}

export function assertSafeBuildEnv(root = process.cwd()) {
  const files = getLegacyEnvFiles(root)
  if (files.length > 0) {
    throw new Error(
      `Unsupported local environment files found: ${files.join(", ")}. ` +
        "Move their settings to the ignored .env.deploy file with npm run config:migrate-local.",
    )
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assertSafeBuildEnv()
}
