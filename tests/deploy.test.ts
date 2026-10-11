import test from "node:test"
import assert from "node:assert/strict"
import { assertWebhookDeployment } from "../scripts/deploy/webhook-config"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertOpenNextBuild } from "../scripts/deploy/validate-worker-build"
import { assertSafeBuildEnv } from "../scripts/deploy/validate-build-env"
import { execFileSync } from "node:child_process"
import { resolve } from "node:path"
import { buildAndPreflightBeforeMigration, buildWorkerCandidate } from "../scripts/deploy/worker-deployment-sequence"

test("deployment loads its separate env file before initializing Cloudflare and respects CI values", t => {
  const directory = mkdtempSync(join(tmpdir(), "nextmail-deploy-env-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(join(directory, ".env.deploy"), "CLOUDFLARE_API_TOKEN=synthetic-token\nAUTH_SECRET=deploy-secret\nEMAIL_DOMAIN=example.com")
  writeFileSync(join(directory, ".env"), "AUTH_SECRET=application-secret")
  const env = { ...process.env }
  for (const name of ["CLOUDFLARE_API_TOKEN", "AUTH_SECRET", "EMAIL_DOMAIN"]) delete env[name]
  const cloudflare = resolve("scripts/deploy/cloudflare.ts")
  const script = `const assert = require('node:assert/strict'); require(${JSON.stringify(cloudflare)}); assert.equal(process.env.CLOUDFLARE_API_TOKEN, 'synthetic-token'); assert.equal(process.env.EMAIL_DOMAIN, 'example.com'); assert.equal(process.env.AUTH_SECRET, process.env.CI_TEST_AUTH || 'deploy-secret')`
  execFileSync(process.execPath, ["--import", import.meta.resolve("tsx"), "-e", script], { cwd: directory, env })
  execFileSync(process.execPath, ["--import", import.meta.resolve("tsx"), "-e", script], { cwd: directory, env: { ...env, AUTH_SECRET: "ci-secret", CI_TEST_AUTH: "ci-secret" } })
})

test("Worker builds reject deployment credentials in every compiled env mode without exposing values", t => {
  const directory = mkdtempSync(join(tmpdir(), "nextmail-build-env-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(join(directory, ".env.deploy"), "CLOUDFLARE_API_TOKEN=synthetic-deploy-token\nGITHUB_TOKEN=synthetic-github-token")
  assert.doesNotThrow(() => assertSafeBuildEnv(directory))
  for (const file of [".env", ".env.local", ".env.production", ".env.production.local", ".env.development", ".env.development.local", ".env.test", ".env.test.local"]) {
    for (const name of ["CLOUDFLARE_API_TOKEN", "GITHUB_TOKEN"]) {
      writeFileSync(join(directory, file), `${name}=synthetic-private-value`)
      assert.throws(() => assertSafeBuildEnv(directory), error => {
        assert.ok(error instanceof Error)
        assert.ok(error.message.includes(file) && error.message.includes(name))
        assert.ok(!error.message.includes("synthetic-private-value"))
        return true
      })
    }
    writeFileSync(join(directory, file), "AUTH_SECRET=synthetic-app-secret\nCLOUDFLARE_API_TOKEN=")
  }
  assert.doesNotThrow(() => assertSafeBuildEnv(directory))
})

test("deployment requires the OpenNext worker artifact and matching Wrangler bindings", t => {
  const directory = mkdtempSync(join(tmpdir(), "nextmail-open-next-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const output = join(directory, ".open-next")
  mkdirSync(join(output, "assets"), { recursive: true })
  writeFileSync(join(output, "worker.js"), "export default {}")
  writeFileSync(join(directory, "wrangler.json"), JSON.stringify({
    main: ".open-next/worker.js",
    assets: { directory: ".open-next/assets", binding: "ASSETS" },
    compatibility_flags: ["nodejs_compat", "nodejs_compat_populate_process_env", "global_fetch_strictly_public"],
    d1_databases: [{ binding: "DB" }],
    kv_namespaces: [{ binding: "SITE_CONFIG" }],
  }))
  assert.doesNotThrow(() => assertOpenNextBuild(directory))

  writeFileSync(join(directory, "wrangler.json"), JSON.stringify({ main: ".vercel/output/static" }))
  assert.throws(() => assertOpenNextBuild(directory), /Wrangler main must target/)
})

test("deployment refuses to break enabled webhooks without trusting saved hosts automatically", () => {
  assert.doesNotThrow(() => assertWebhookDeployment([], ""))
  assert.throws(() => assertWebhookDeployment(["https://hooks.example.com/private-token"], ""), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /WEBHOOK_ALLOWED_HOSTS/)
    assert.match(error.message, /hooks.example.com/)
    assert.ok(!error.message.includes("private-token"))
    return true
  })
  assert.doesNotThrow(() => assertWebhookDeployment(["https://hooks.example.com/event"], "hooks.example.com"))
  assert.throws(() => assertWebhookDeployment(["https://other.example.com/event"], "hooks.example.com"))
  assert.throws(() => assertWebhookDeployment(["http://hooks.example.com/event"], "hooks.example.com"))
})

test("deployment builds and preflights the Worker before migrating D1", async () => {
  const events: string[] = []
  const result = await buildAndPreflightBeforeMigration(
    () => buildWorkerCandidate(command => events.push(command)),
    async () => {
      events.push("preflight")
      return "synthetic-database"
    },
    () => events.push("migration"),
  )
  assert.equal(result, "synthetic-database")
  assert.deepEqual(events, [
    "npm run build:worker",
    "npx wrangler deploy --dry-run --config wrangler.json",
    "preflight",
    "migration",
  ])

  events.length = 0
  await assert.rejects(buildAndPreflightBeforeMigration(
    () => buildWorkerCandidate(command => {
      events.push(command)
      if (command.includes("--dry-run")) throw new Error("synthetic bundle failure")
    }),
    async () => {
      events.push("preflight")
    },
    () => events.push("migration"),
  ), /synthetic bundle failure/)
  assert.deepEqual(events, ["npm run build:worker", "npx wrangler deploy --dry-run --config wrangler.json"])

  events.length = 0
  await assert.rejects(buildAndPreflightBeforeMigration(
    () => events.push("build"),
    async () => {
      events.push("preflight")
      throw new Error("synthetic webhook preflight failure")
    },
    () => events.push("migration"),
  ), /synthetic webhook preflight failure/)
  assert.deepEqual(events, ["build", "preflight"])
})
