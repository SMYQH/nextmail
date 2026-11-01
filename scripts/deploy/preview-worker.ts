import { spawn } from "node:child_process"
import { resolve } from "node:path"
import { preloadAppEnv } from "./app-env"
import { createLocalWranglerConfig } from "./local-wrangler-config"

preloadAppEnv("preview")

async function previewWorker() {
  const root = process.cwd()
  const localWrangler = createLocalWranglerConfig(root)
  const cliPath = resolve(root, "node_modules/@opennextjs/cloudflare/dist/cli/index.js")

  try {
    const exitCode = await new Promise<number>((resolveExit, reject) => {
      const child = spawn(process.execPath, [
        cliPath,
        "preview",
        "--config",
        localWrangler.configPath,
        "--local",
        "--persist-to",
        localWrangler.wranglerPersistPath,
      ], { cwd: root, env: process.env, stdio: "inherit" })

      child.once("error", reject)
      child.once("exit", (code, signal) => {
        if (code !== null) resolveExit(code)
        else if (signal) resolveExit(1)
        else resolveExit(1)
      })
    })
    process.exitCode = exitCode
  } finally {
    localWrangler.cleanup()
  }
}

void previewWorker().catch(error => {
  console.error(error instanceof Error ? error.message : "OpenNext preview failed.")
  process.exitCode = 1
})
