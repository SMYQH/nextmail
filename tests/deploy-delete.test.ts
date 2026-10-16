import test, { after, mock } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const originalDirectory = process.cwd()
const originalEnvironment = { ...process.env }
const fixtureDirectory = mkdtempSync(join(tmpdir(), "nextmail-deploy-cleanup-"))
process.chdir(fixtureDirectory)
after(() => {
  mock.restoreAll()
  process.chdir(originalDirectory)
  process.env = originalEnvironment
  rmSync(fixtureDirectory, { recursive: true, force: true })
})

const cloudflareState: {
  tokenStatus: { status: string; expires_on?: string | null; not_before?: string | null }
  userTokenError?: Error
  accountTokenError?: Error
  verifiers: string[]
  resourceReads: number
  zones: Array<{ id: string; name: string }>
  workerScripts: Array<{ id: string }>
  workerRoutes: Array<{ id: string; zone_id: string; pattern: string; script: string }>
  database?: { uuid: string; name: string }
  otherDatabases: Array<{ uuid: string; name: string }>
  namespaces: Array<{ id: string; title: string }>
  otherNamespaces: Array<{ id: string; title: string }>
  catchAll?: Record<string, unknown> & {
    enabled?: boolean
    actions?: Array<{ type?: string; value?: string[] }>
    matchers?: Array<{ type: string }>
  }
  deleted: string[]
} = {
  tokenStatus: { status: "active" },
  verifiers: [],
  resourceReads: 0,
  zones: [],
  workerScripts: [],
  workerRoutes: [],
  otherDatabases: [],
  namespaces: [],
  otherNamespaces: [],
  deleted: [],
}

class MockNotFoundError extends Error {}

class MockCloudflare {
  user = { tokens: { verify: async () => {
    cloudflareState.verifiers.push("user")
    if (cloudflareState.userTokenError) throw cloudflareState.userTokenError
    return cloudflareState.tokenStatus
  } } }

  accounts = { tokens: { verify: async ({ account_id }: { account_id: string }) => {
    cloudflareState.verifiers.push(`account:${account_id}`)
    if (cloudflareState.accountTokenError) throw cloudflareState.accountTokenError
    return cloudflareState.tokenStatus
  } } }

  zones = {
    list: async function* () {
      cloudflareState.resourceReads++
      yield* cloudflareState.zones
    },
  }

  d1 = {
    database: {
      list: async function* () {
        if (cloudflareState.database) yield cloudflareState.database
      },
      get: async (id: string) => {
        const database = [cloudflareState.database, ...cloudflareState.otherDatabases]
          .find(candidate => candidate?.uuid === id)
        if (!database) throw new MockNotFoundError()
        return database
      },
      delete: async (id: string) => {
        cloudflareState.deleted.push(`d1:${id}`)
      },
    },
  }

  kv = {
    namespaces: {
      list: async function* () {
        yield* cloudflareState.namespaces
      },
      get: async (id: string) => {
        const namespace = [...cloudflareState.namespaces, ...cloudflareState.otherNamespaces]
          .find(candidate => candidate.id === id)
        if (!namespace) throw new MockNotFoundError()
        return namespace
      },
      delete: async (id: string) => {
        cloudflareState.deleted.push(`kv:${id}`)
      },
    },
  }

  workers = {
    scripts: {
      list: async function* () {
        yield* cloudflareState.workerScripts
      },
      delete: async (name: string) => {
        cloudflareState.deleted.push(`worker:${name}`)
      },
    },
    routes: {
      list: async function* ({ zone_id }: { zone_id: string }) {
        yield* cloudflareState.workerRoutes.filter(route => route.zone_id === zone_id)
      },
      delete: async (id: string) => {
        cloudflareState.deleted.push(`route:${id}`)
      },
    },
  }

  emailRouting = {
    rules: {
      catchAlls: {
        get: async () => {
          if (!cloudflareState.catchAll) throw new MockNotFoundError()
          return cloudflareState.catchAll
        },
        update: async (args: Record<string, unknown>) => {
          cloudflareState.deleted.push("catch-all:disable")
          cloudflareState.catchAll = { ...cloudflareState.catchAll, ...args }
          return cloudflareState.catchAll
        },
      },
    },
  }
}

process.env.CLOUDFLARE_ACCOUNT_ID = "synthetic-account"
process.env.CLOUDFLARE_API_TOKEN = "synthetic-token"
process.env.EMAIL_DOMAIN = "example.invalid"
process.env.CUSTOM_DOMAIN = "app.example.invalid"
delete process.env.DATABASE_ID
delete process.env.KV_NAMESPACE_ID

const cloudflareMock = mock.module("cloudflare", {
  defaultExport: MockCloudflare,
  namedExports: { NotFoundError: MockNotFoundError },
})
after(() => cloudflareMock.restore())

const [{ deleteProjectResources }, { verifyCloudflareDeployAccess }] = await Promise.all([
  import("../scripts/deploy/delete"),
  import("../scripts/deploy/cloudflare"),
])

function resetCloudflareState() {
  writeFileSync(join(fixtureDirectory, "wrangler.json"), JSON.stringify({
    routes: [{ pattern: "app.example.invalid/*", zone_name: "example.invalid" }],
  }))
  cloudflareState.tokenStatus = { status: "active" }
  cloudflareState.userTokenError = undefined
  cloudflareState.accountTokenError = undefined
  cloudflareState.verifiers = []
  cloudflareState.resourceReads = 0
  cloudflareState.zones = [{ id: "zone-project", name: "example.invalid" }]
  cloudflareState.workerScripts = [
    { id: "nextmail" },
    { id: "email-receiver-worker" },
    { id: "cleanup-worker" },
    { id: "unrelated-worker" },
  ]
  cloudflareState.workerRoutes = [
    { id: "project-route", zone_id: "zone-project", pattern: "app.example.invalid/*", script: "nextmail" },
    { id: "unrelated-route", zone_id: "zone-project", pattern: "api.example.invalid/*", script: "nextmail" },
    { id: "other-worker-route", zone_id: "zone-project", pattern: "app.example.invalid/*", script: "other-worker" },
  ]
  cloudflareState.database = { uuid: "project-d1", name: "nextmail-d1" }
  cloudflareState.otherDatabases = [{ uuid: "other-d1", name: "unrelated-database" }]
  cloudflareState.namespaces = [{ id: "project-kv", title: "nextmail-kv" }]
  cloudflareState.otherNamespaces = [{ id: "other-kv", title: "unrelated-namespace" }]
  cloudflareState.catchAll = {
    enabled: true,
    actions: [{ type: "worker", value: ["email-receiver-worker"] }],
    matchers: [{ type: "all" }],
    name: "NextMail Catch All",
  }
  cloudflareState.deleted = []
  process.env.CLOUDFLARE_ACCOUNT_ID = "synthetic-account"
  process.env.CLOUDFLARE_API_TOKEN = "synthetic-token"
  process.env.EMAIL_DOMAIN = "example.invalid"
  process.env.CUSTOM_DOMAIN = "app.example.invalid"
  delete process.env.DATABASE_ID
  delete process.env.KV_NAMESPACE_ID
}

test("cleanup deletes only identified NextMail Cloudflare resources", async () => {
  resetCloudflareState()

  await deleteProjectResources()

  assert.deepEqual(cloudflareState.deleted, [
    "catch-all:disable",
    "route:project-route",
    "worker:nextmail",
    "worker:email-receiver-worker",
    "worker:cleanup-worker",
    "kv:project-kv",
    "d1:project-d1",
  ])
  assert.equal(cloudflareState.catchAll?.enabled, false)
})

test("cleanup refuses an inactive Cloudflare token before making changes", async () => {
  resetCloudflareState()
  cloudflareState.tokenStatus = { status: "disabled" }

  await assert.rejects(deleteProjectResources(), /not currently usable/)
  assert.deepEqual(cloudflareState.deleted, [])
  assert.deepEqual(cloudflareState.verifiers, ["user"])
  assert.equal(cloudflareState.resourceReads, 0)
})

test("cleanup removes configured routes when CUSTOM_DOMAIN is unset", async () => {
  resetCloudflareState()
  delete process.env.CUSTOM_DOMAIN

  await deleteProjectResources()

  assert.ok(cloudflareState.deleted.includes("route:project-route"))
  assert.ok(!cloudflareState.deleted.includes("route:unrelated-route"))
})

test("preflight accepts account-owned tokens after user verification rejects them", async () => {
  resetCloudflareState()
  cloudflareState.userTokenError = new Error("Not a user-owned token")

  const access = await verifyCloudflareDeployAccess({ emailDomain: "example.invalid" })

  assert.deepEqual(cloudflareState.verifiers, ["user", "account:synthetic-account"])
  assert.equal(access.emailCatchAllTarget.zone.id, "zone-project")
  assert.ok(access.existingWorkerNames.has("nextmail"))
  assert.deepEqual(cloudflareState.deleted, [])
})

test("cleanup accepts an active account-owned token", async () => {
  resetCloudflareState()
  cloudflareState.userTokenError = new Error("Not a user-owned token")

  await deleteProjectResources()

  assert.deepEqual(cloudflareState.verifiers, ["user", "account:synthetic-account"])
  assert.ok(cloudflareState.deleted.includes("worker:nextmail"))
})

test("preflight rejects invalid and inactive account tokens before resource access", async () => {
  for (const scenario of ["invalid", "disabled", "expired", "future"]) {
    resetCloudflareState()
    cloudflareState.userTokenError = new Error("Not a user-owned token")
    if (scenario === "invalid") cloudflareState.accountTokenError = new Error("Invalid token")
    if (scenario === "disabled") cloudflareState.tokenStatus.status = "disabled"
    if (scenario === "expired") cloudflareState.tokenStatus.expires_on = "2000-01-01T00:00:00Z"
    if (scenario === "future") cloudflareState.tokenStatus.not_before = "2999-01-01T00:00:00Z"

    await assert.rejects(
      verifyCloudflareDeployAccess({ emailDomain: "example.invalid" }),
      /invalid or unavailable|not currently usable/,
    )
    assert.equal(cloudflareState.resourceReads, 0)
    assert.deepEqual(cloudflareState.deleted, [])
  }
})

test("cleanup refuses an explicit D1 ID that belongs to another database", async () => {
  resetCloudflareState()
  process.env.DATABASE_ID = "other-d1"

  await assert.rejects(deleteProjectResources(), /does not point to the project database/)
  assert.deepEqual(cloudflareState.deleted, [])
})

test("cleanup can be rerun when configured IDs already point to deleted resources", async () => {
  resetCloudflareState()
  cloudflareState.workerScripts = []
  cloudflareState.workerRoutes = []
  cloudflareState.database = undefined
  cloudflareState.namespaces = []
  cloudflareState.catchAll!.enabled = false
  process.env.DATABASE_ID = "deleted-d1"
  process.env.KV_NAMESPACE_ID = "deleted-kv"

  await assert.doesNotReject(deleteProjectResources())
  assert.deepEqual(cloudflareState.deleted, [])
})

test("Cloudflare preflight stops before resource checks for an expired token", async () => {
  resetCloudflareState()
  cloudflareState.tokenStatus = { status: "active", expires_on: "2000-01-01T00:00:00Z" }

  await assert.rejects(
    verifyCloudflareDeployAccess({ emailDomain: "example.invalid" }),
    /not currently usable/,
  )
  assert.deepEqual(cloudflareState.deleted, [])
})

const { buildAndPreflightBeforeMigration } = await import("../scripts/deploy/worker-deployment-sequence")
const stoppedAtBuild = new Error("Stop before building or changing remote resources")
const buildCandidate = mock.fn(() => { throw stoppedAtBuild })
const deploymentSequenceMock = mock.module("../scripts/deploy/worker-deployment-sequence", {
  namedExports: { buildAndPreflightBeforeMigration, buildWorkerCandidate: buildCandidate },
})
after(() => deploymentSequenceMock.restore())
const { main } = await import("../scripts/deploy/index")

const deploymentTargets = [undefined, "app.example.invalid"].flatMap(customDomain =>
  [false, true].map(workerExists => ({ customDomain, workerExists })),
)
for (const { customDomain, workerExists } of deploymentTargets) {
  test(`${workerExists ? "existing" : "fresh"} deployment ignores stale routes for ${customDomain ?? "workers.dev"}`, async t => {
    resetCloudflareState()
    if (!workerExists) cloudflareState.workerScripts = []
    buildCandidate.mock.resetCalls()
    process.env.AUTH_SECRET = "synthetic-auth-secret"
    if (customDomain) process.env.CUSTOM_DOMAIN = customDomain
    else delete process.env.CUSTOM_DOMAIN
    writeFileSync(join(fixtureDirectory, "wrangler.json"), JSON.stringify({
      routes: [{ pattern: "app.stale.invalid/*", zone_name: "stale.invalid" }],
    }))
    const exit = mock.method(process, "exit", () => { throw stoppedAtBuild })
    const errors = mock.method(console, "error", () => {})
    t.after(() => {
      exit.mock.restore()
      errors.mock.restore()
    })

    await assert.rejects(main(), error => error === stoppedAtBuild)

    assert.equal(buildCandidate.mock.callCount(), 1)
    assert.deepEqual(errors.mock.calls[0].arguments, ["❌ Deployment failed:", stoppedAtBuild])
    const config = JSON.parse(readFileSync(join(fixtureDirectory, "wrangler.json"), "utf8"))
    assert.equal(config.workers_dev, workerExists && !customDomain)
    assert.deepEqual(config.routes, workerExists && customDomain
      ? [{ pattern: "app.example.invalid", zone_name: "example.invalid", custom_domain: true }]
      : undefined)
    assert.deepEqual(cloudflareState.deleted, [])
  })
}

test("custom-domain preflight configures a managed hostname without a wildcard or existing DNS dependency", async () => {
  resetCloudflareState()

  const access = await verifyCloudflareDeployAccess({
    emailDomain: "example.invalid",
    customDomain: "https://APP.example.invalid/",
  })

  assert.deepEqual(access.workerRoute, {
    pattern: "app.example.invalid",
    zone_name: "example.invalid",
    custom_domain: true,
  })
  assert.deepEqual(cloudflareState.deleted, [])
})
