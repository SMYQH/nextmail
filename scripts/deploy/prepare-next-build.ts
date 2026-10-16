import { rmSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { assertSafeBuildEnv } from "./validate-build-env"

export function prepareNextBuild(root = process.cwd()) {
  assertSafeBuildEnv(root)
  // Route types and incremental state must come from the same build.
  rmSync(resolve(root, ".next"), { recursive: true, force: true })
  rmSync(resolve(root, "tsconfig.tsbuildinfo"), { force: true })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  prepareNextBuild()
  console.log("Cleared generated Next.js output and TypeScript build cache")
}
