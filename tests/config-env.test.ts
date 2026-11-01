import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { parse } from "dotenv"
import { execFileSync } from "node:child_process"
import { assertSafeBuildEnv, getLegacyEnvFiles } from "../scripts/deploy/validate-build-env"
import { assertOpenNextBuild } from "../scripts/deploy/validate-worker-build"
import { createLocalWranglerConfig } from "../scripts/deploy/local-wrangler-config"
import { migrateLocalConfig } from "../scripts/migrate-local-config.mjs"
import playwrightConfig from "../playwright.config"

function makeWorkerArtifact(root: string, workerSource = "export default {}") {
  const output = join(root, ".open-next")
  mkdirSync(join(output, "assets"), { recursive: true })
  writeFileSync(join(output, "worker.js"), workerSource)
  writeFileSync(join(root, "wrangler.json"), JSON.stringify({
    main: ".open-next/worker.js",
    assets: { directory: ".open-next/assets", binding: "ASSETS" },
    compatibility_flags: ["nodejs_compat", "nodejs_compat_populate_process_env", "global_fetch_strictly_public"],
    d1_databases: [{ binding: "DB" }],
    kv_namespaces: [{ binding: "SITE_CONFIG" }],
  }))
}

test("builds reject legacy env files and accept only .env.deploy", t => {
  const root = mkdtempSync(join(tmpdir(), "nextmail-config-guard-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, ".env.deploy"), "AUTH_SECRET=synthetic-config-secret")
  assert.doesNotThrow(() => assertSafeBuildEnv(root))

  for (const name of [
    ".env",
    ".env.local",
    ".env.development",
    ".env.development.local",
    ".env.production",
    ".env.production.local",
    ".env.test",
    ".env.test.local",
    ".env.staging",
    ".env.legacy",
    ".dev.vars",
    ".dev.vars.development",
  ]) {
    const file = join(root, name)
    writeFileSync(file, "AUTH_SECRET=synthetic-private-value")
    assert.throws(() => assertSafeBuildEnv(root), error => {
      assert.ok(error instanceof Error)
      assert.ok(error.message.includes(name))
      assert.ok(!error.message.includes("synthetic-private-value"))
      return true
    })
    rmSync(file)
  }
  assert.deepEqual(getLegacyEnvFiles(root), [])
})

test("local migration keeps .env.deploy active and preserves the full legacy file", t => {
  const root = mkdtempSync(join(tmpdir(), "nextmail-config-migrate-"))
  const backupRoot = mkdtempSync(join(tmpdir(), "nextmail-config-backups-"))
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(backupRoot, { recursive: true, force: true })
  })
  const target = "AUTH_SECRET=canonical-auth-secret\nNEXT_PUBLIC_BASE_URL=https://local.example.test\n"
  const legacy = "# preserved legacy settings\nAUTH_SECRET=previous-auth-secret\nNEXT_PUBLIC_BASE_URL=http://localhost:3000\nLEGACY_ONLY=local-value\n"
  writeFileSync(join(root, ".env.deploy"), target)
  writeFileSync(join(root, ".env"), legacy)

  const result = migrateLocalConfig(root, { makeSecret: () => "new-random-auth-secret", backupRoot })

  assert.deepEqual(result.legacyFiles, [".env"])
  assert.deepEqual(result.conflicts, ["AUTH_SECRET", "NEXT_PUBLIC_BASE_URL"])
  assert.deepEqual(result.addedVariables, ["LEGACY_ONLY"])
  assert.equal(readFileSync(join(result.backupDirectory!, ".env"), "utf8"), legacy)
  assert.equal(existsSync(join(root, ".env")), false)
  assert.equal(existsSync(join(root, ".env.legacy")), false)
  assert.deepEqual(parse(readFileSync(join(root, ".env.deploy"))), {
    AUTH_SECRET: "canonical-auth-secret",
    NEXT_PUBLIC_BASE_URL: "https://local.example.test",
    LEGACY_ONLY: "local-value",
  })
  assert.deepEqual(getLegacyEnvFiles(root), [])
})

test("migration seeds .env.deploy from the template and retires arbitrary legacy env modes", t => {
  const root = mkdtempSync(join(tmpdir(), "nextmail-config-fresh-"))
  const backupRoot = mkdtempSync(join(tmpdir(), "nextmail-config-backups-"))
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(backupRoot, { recursive: true, force: true })
  })
  writeFileSync(join(root, ".env.deploy.example"), "AUTH_SECRET=\nNEXT_PUBLIC_BASE_URL=\n")
  const legacy = "AUTH_SECRET=legacy-auth-secret\nNEXT_PUBLIC_BASE_URL=http://localhost:3000\n"
  writeFileSync(join(root, ".dev.vars.development"), legacy)
  writeFileSync(join(root, ".env.staging"), "LOCAL_ONLY=staging-value\n")

  const result = migrateLocalConfig(root, { makeSecret: () => "generated-auth-secret", backupRoot })

  assert.equal(result.generatedAuthSecret, false)
  assert.deepEqual(result.conflicts, [])
  assert.deepEqual(result.legacyFiles, [".dev.vars.development", ".env.staging"])
  assert.equal(readFileSync(join(result.backupDirectory!, ".dev.vars.development"), "utf8"), legacy)
  assert.equal(readFileSync(join(result.backupDirectory!, ".env.staging"), "utf8"), "LOCAL_ONLY=staging-value\n")
  assert.deepEqual(result.addedVariables, ["AUTH_SECRET", "LOCAL_ONLY", "NEXT_PUBLIC_BASE_URL"])
  assert.deepEqual(parse(readFileSync(join(root, ".env.deploy"))), {
    AUTH_SECRET: "legacy-auth-secret",
    NEXT_PUBLIC_BASE_URL: "http://localhost:3000",
    LOCAL_ONLY: "staging-value",
  })
})

test("migration stops on conflicting legacy-only values without changing local files", t => {
  const root = mkdtempSync(join(tmpdir(), "nextmail-config-ambiguous-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const target = "AUTH_SECRET=canonical-auth-secret\n"
  const first = "LOCAL_ONLY=first-local-value\n"
  const second = "LOCAL_ONLY=second-local-value\n"
  writeFileSync(join(root, ".env.deploy"), target)
  writeFileSync(join(root, ".env"), first)
  writeFileSync(join(root, ".env.local"), second)

  assert.throws(() => migrateLocalConfig(root), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /LOCAL_ONLY/)
    assert.ok(!error.message.includes("first-local-value"))
    assert.ok(!error.message.includes("second-local-value"))
    return true
  })
  assert.equal(readFileSync(join(root, ".env.deploy"), "utf8"), target)
  assert.equal(readFileSync(join(root, ".env"), "utf8"), first)
  assert.equal(readFileSync(join(root, ".env.local"), "utf8"), second)
  assert.equal(existsSync(join(root, ".env.legacy")), false)
})

test("OpenNext static fallback and runtime env output omit values from .env.deploy", async t => {
  const root = mkdtempSync(join(tmpdir(), "nextmail-opennext-env-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, ".env.deploy"), [
    "AUTH_SECRET=deploy-only-secret-sentinel",
    "NEXT_PUBLIC_BASE_URL=https://deploy-only-public-sentinel.example.test",
    "",
  ].join("\n"))

  const compilerPath = resolve("node_modules/@opennextjs/cloudflare/dist/cli/build/open-next/compile-env-files.js")
  const { compileEnvFiles } = await import(pathToFileURL(compilerPath).href) as {
    compileEnvFiles(options: { outputDir: string; appPath: string; monorepoRoot: string }): void
  }
  compileEnvFiles({ outputDir: join(root, ".open-next"), appPath: root, monorepoRoot: root })

  const emitted = readFileSync(join(root, ".open-next", "cloudflare", "next-env.mjs"), "utf8")
  assert.match(emitted, /export const production/)
  assert.match(emitted, /export const development/)
  assert.match(emitted, /export const test/)
  assert.doesNotMatch(emitted, /deploy-only-secret-sentinel|deploy-only-public-sentinel/)
})

test("local Wrangler config carries only configured secret names and keeps project bindings and state", t => {
  const root = mkdtempSync(join(tmpdir(), "nextmail-local-wrangler-config-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, "wrangler.json"), JSON.stringify({
    name: "nextmail-local-test",
    main: ".open-next/worker.js",
    compatibility_date: "2025-04-01",
    compatibility_flags: ["nodejs_compat"],
    assets: { directory: ".open-next/assets", binding: "ASSETS" },
    d1_databases: [{ binding: "DB", database_name: "nextmail-local", database_id: "local-database-id", migrations_dir: "drizzle" }],
    kv_namespaces: [{ binding: "SITE_CONFIG", id: "local-kv-namespace-id" }],
  }))

  const secretValues = {
    GITHUB_ACTIONS: "true",
    AUTH_SECRET: "synthetic-auth-secret-value",
    AUTH_GITHUB_ID: "synthetic-github-id-value",
  }
  const local = createLocalWranglerConfig(root, secretValues)
  t.after(() => local.cleanup())

  const content = readFileSync(local.configPath, "utf8")
  const config = JSON.parse(content) as {
    main: string
    assets: { directory: string }
    d1_databases: Array<{ database_id: string; migrations_dir: string }>
    kv_namespaces: Array<{ id: string }>
    secrets: { required: string[] }
  }
  assert.deepEqual(local.requiredSecrets, ["AUTH_SECRET", "AUTH_GITHUB_ID"])
  assert.deepEqual(config.secrets.required, ["AUTH_SECRET", "AUTH_GITHUB_ID"])
  assert.equal(config.main, resolve(root, ".open-next/worker.js"))
  assert.equal(config.assets.directory, resolve(root, ".open-next/assets"))
  assert.equal(config.d1_databases[0].database_id, "local-database-id")
  assert.equal(config.d1_databases[0].migrations_dir, resolve(root, "drizzle"))
  assert.equal(config.kv_namespaces[0].id, "local-kv-namespace-id")
  assert.equal(local.proxyPersistPath, resolve(root, ".wrangler/state/v3"))
  assert.equal(local.wranglerPersistPath, resolve(root, ".wrangler/state"))
  assert.equal(realpathSync(join(resolve(root, ".test/results/runtime-config"), "..")), realpathSync(join(root, ".test/results")))
  assert.ok(local.configPath.startsWith(resolve(root, ".test/results/runtime-config")))
  assert.ok(!content.includes(secretValues.AUTH_SECRET))
  assert.ok(!content.includes(secretValues.AUTH_GITHUB_ID))
  const runtimeDirectory = resolve(local.configPath, "..")
  local.cleanup()
  assert.equal(existsSync(runtimeDirectory), false)
  assert.equal(existsSync(join(root, ".wrangler/state")), true)
})

test("local Wrangler bindings receive process secrets and CI never loads ignored local config", async t => {
  const root = mkdtempSync(join(tmpdir(), "nextmail-local-wrangler-proxy-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, ".open-next/assets"), { recursive: true })
  mkdirSync(join(root, "drizzle"), { recursive: true })
  writeFileSync(join(root, ".open-next/worker.js"), "export default { fetch() { return new Response('ok') } }")
  writeFileSync(join(root, "wrangler.json"), JSON.stringify({
    name: "nextmail-local-proxy-test",
    main: ".open-next/worker.js",
    compatibility_date: "2025-04-01",
    compatibility_flags: ["nodejs_compat"],
    assets: { directory: ".open-next/assets", binding: "ASSETS" },
    d1_databases: [{ binding: "DB", database_name: "nextmail-local", database_id: "local-database-id", migrations_dir: "drizzle" }],
    kv_namespaces: [{ binding: "SITE_CONFIG", id: "00000000000000000000000000000001" }],
  }))

  const localSecret = "synthetic-process-auth-secret"
  const previousSecret = process.env.AUTH_SECRET
  process.env.AUTH_SECRET = localSecret
  const local = createLocalWranglerConfig(root, { AUTH_SECRET: localSecret })
  t.after(() => {
    local.cleanup()
    if (previousSecret === undefined) delete process.env.AUTH_SECRET
    else process.env.AUTH_SECRET = previousSecret
  })

  const { getPlatformProxy } = await import("wrangler")
  const wranglerPath = resolve("node_modules/wrangler/bin/wrangler.js")
  const namespaceId = "00000000000000000000000000000001"
  const wranglerEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
  }
  for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CF_API_TOKEN", "CF_API_KEY"]) delete wranglerEnv[name]
  try {
    execFileSync(process.execPath, [
      wranglerPath,
      "kv", "key", "put", "shared-state-probe-key", "shared-state-probe-value",
      "--namespace-id", namespaceId,
      "--local",
      "--persist-to", local.wranglerPersistPath,
      "--config", local.configPath,
    ], { cwd: root, env: wranglerEnv, stdio: "pipe" })
  } catch {
    assert.fail("Local Wrangler KV seeding failed without exposing the command arguments.")
  }

  const proxy = await getPlatformProxy<{
    AUTH_SECRET?: string
    DB: unknown
    SITE_CONFIG: { get(key: string): Promise<string | null> }
  }>({
    configPath: local.configPath,
    envFiles: [],
    remoteBindings: false,
    persist: { path: local.proxyPersistPath },
  })
  try {
    assert.equal(proxy.env.AUTH_SECRET, localSecret)
    assert.ok(proxy.env.DB)
    assert.ok(proxy.env.SITE_CONFIG)
    assert.ok(await proxy.env.SITE_CONFIG.get("shared-state-probe-key") === "shared-state-probe-value", "Wrangler and the local proxy must share KV persistence")
  } finally {
    await proxy.dispose()
  }
  local.cleanup()
  assert.equal(existsSync(join(root, ".wrangler/state/v3")), true)

  writeFileSync(join(root, ".env.deploy"), [
    "AUTH_SECRET=synthetic-local-file-secret",
    "CLOUDFLARE_API_TOKEN=synthetic-local-file-token",
    "LOCAL_ONLY=synthetic-local-file-setting",
    "",
  ].join("\n"))
  const env = { ...process.env }
  delete env.AUTH_SECRET
  delete env.CLOUDFLARE_API_TOKEN
  delete env.LOCAL_ONLY
  env.GITHUB_ACTIONS = "true"
  const preloadModules = ["scripts/deploy/load-env.ts", "scripts/deploy/preload-app-env.ts"]
  for (const preload of preloadModules) {
    const modulePath = pathToFileURL(resolve(preload)).href
    const script = "console.log(process.env.AUTH_SECRET === undefined && process.env.CLOUDFLARE_API_TOKEN === undefined && process.env.LOCAL_ONLY === undefined ? 'no-local-fallback' : 'unexpected-local-fallback')"
    const output = execFileSync(process.execPath, [
      "--import", import.meta.resolve("tsx"),
      "--import", modulePath,
      "-e", script,
    ], { cwd: root, env, encoding: "utf8" })
    assert.equal(output.trim(), "no-local-fallback")

    const localEnv = { ...env, GITHUB_ACTIONS: "false", AUTH_SECRET: "synthetic-process-secret" }
    const localScript = "console.log(process.env.AUTH_SECRET === 'synthetic-process-secret' && process.env.LOCAL_ONLY === 'synthetic-local-file-setting' ? 'process-env-wins' : 'unexpected-local-env')"
    const localOutput = execFileSync(process.execPath, [
      "--import", import.meta.resolve("tsx"),
      "--import", modulePath,
      "-e", localScript,
    ], { cwd: root, env: localEnv, encoding: "utf8" })
    assert.equal(localOutput.trim(), "process-env-wins")
  }

  const previewEnv = {
    ...env,
    AUTH_SECRET: "synthetic-process-auth-secret",
    CLOUDFLARE_API_TOKEN: "synthetic-deploy-token",
    ADMIN_USERS: "synthetic-admin-config",
    RESEND_CONFIG: "synthetic-resend-config",
    TURNSTILE_SECRET_KEY: "synthetic-turnstile-secret",
    NEXTMAIL_DEPLOY_DEFAULT_ROLE: "synthetic-deploy-role",
  }
  const appEnvPath = pathToFileURL(resolve("scripts/deploy/app-env.ts")).href
  const previewScript = `
    const { preloadAppEnv } = await import(${JSON.stringify(appEnvPath)});
    preloadAppEnv('preview');
    const removed = ['CLOUDFLARE_API_TOKEN', 'ADMIN_USERS', 'RESEND_CONFIG', 'TURNSTILE_SECRET_KEY', 'NEXTMAIL_DEPLOY_DEFAULT_ROLE'];
    console.log(removed.every(name => process.env[name] === undefined) && process.env.AUTH_SECRET === 'synthetic-process-auth-secret' ? 'preview-env-filtered' : 'preview-env-leaked');
  `
  const previewOutput = execFileSync(process.execPath, [
    "--import", import.meta.resolve("tsx"),
    "--input-type=module", "-e", previewScript,
  ], { cwd: root, env: previewEnv, encoding: "utf8" })
  assert.equal(previewOutput.trim(), "preview-env-filtered")
})

test("Worker artifact validation rejects copied env files and configured credentials", t => {
  const root = mkdtempSync(join(tmpdir(), "nextmail-worker-artifact-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, ".env.deploy"), [
    "AUTH_SECRET=worker-secret-sentinel",
    "CLOUDFLARE_API_TOKEN=worker-cloudflare-token-sentinel",
    "",
  ].join("\n"))
  makeWorkerArtifact(root, "export default { secret: 'worker-secret-sentinel' }")

  assert.throws(() => assertOpenNextBuild(root), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /AUTH_SECRET/)
    assert.ok(!error.message.includes("worker-secret-sentinel"))
    return true
  })

  writeFileSync(join(root, ".open-next", "worker.js"), "const token = 'worker-cloudflare-token-sentinel'; export default {}")
  assert.throws(() => assertOpenNextBuild(root), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /CLOUDFLARE_API_TOKEN/)
    assert.ok(!error.message.includes("worker-cloudflare-token-sentinel"))
    return true
  })

  writeFileSync(join(root, ".open-next", "worker.js"), "export default {}")
  writeFileSync(join(root, ".open-next", ".env.deploy"), "AUTH_SECRET=worker-secret-sentinel\n")
  assert.throws(() => assertOpenNextBuild(root), /environment file/)
})

test("Worker credential scanning ignores admin API key names and expiry metadata", t => {
  const root = mkdtempSync(join(tmpdir(), "nextmail-worker-artifact-admin-key-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const apiKey = "synthetic-admin-api-key-secret"
  const adminConfig = JSON.stringify([{
    username: "automation-user",
    apiKeys: [{ name: "automation", key: apiKey, expiresAt: "2030-01-01T00:00:00.000Z" }],
  }])
  writeFileSync(join(root, ".env.deploy"), `ADMIN_USERS='${adminConfig}'\n`)
  makeWorkerArtifact(root, "const metadata = 'automation 2030-01-01T00:00:00.000Z'; export default {}")
  assert.doesNotThrow(() => assertOpenNextBuild(root))

  writeFileSync(join(root, ".open-next/worker.js"), `const key = '${apiKey}'; export default {}`)
  assert.throws(() => assertOpenNextBuild(root), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /ADMIN_USERS\.0\.apiKeys\.0\.key/)
    assert.ok(!error.message.includes(apiKey))
    return true
  })
})

test("Playwright reporters and output artifacts stay under .test", () => {
  assert.equal(playwrightConfig.outputDir, ".test/results/browser")
  const reporters = playwrightConfig.reporter as [string, Record<string, unknown>][]
  assert.equal(reporters.find(([name]) => name === "html")?.[1].outputFolder, ".test/playwright")
  assert.equal(reporters.find(([name]) => name === "json")?.[1].outputFile, ".test/results/results.json")
})
