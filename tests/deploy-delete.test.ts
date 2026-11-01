import test, { after, mock } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

const originalEnvironment = { ...process.env }
const temporaryRoot = resolve(tmpdir())
const fixtureDirectory = resolve(mkdtempSync(join(temporaryRoot, "nextmail-deploy-cleanup-")))
after(() => {
  mock.restoreAll()
  process.env = originalEnvironment

  const cleanupTarget = resolve(fixtureDirectory)
  const relativeCleanupTarget = relative(temporaryRoot, cleanupTarget)
  assert.equal(cleanupTarget, fixtureDirectory)
  assert.ok(
    relativeCleanupTarget &&
      relativeCleanupTarget !== ".." &&
      !relativeCleanupTarget.startsWith(`..${sep}`) &&
      !isAbsolute(relativeCleanupTarget),
    `Refusing to remove a fixture outside the temp directory: ${cleanupTarget}`,
  )
  rmSync(cleanupTarget, { recursive: true, force: true })
})

const cloudflareState: {
  tokenStatus: { status: string; expires_on?: string | null; not_before?: string | null }
  userTokenError?: Error
  accountTokenError?: Error
  verifiers: string[]
  resourceReads: number
  zones: Array<{ id: string; name: string }>
  botManagement: { fight_mode?: boolean; stale_zone_configuration?: { fight_mode?: boolean } }
  botManagementReads: number
  wafEntryPoint?: { name?: string; description?: string; rules?: Array<Record<string, unknown>> }
  wafUpdates: Array<{ name?: string; description?: string; rules?: Array<Record<string, unknown>> }>
  workerScripts: Array<{ id: string }>
  workerRoutes: Array<{ id: string; zone_id: string; pattern: string; script: string }>
  database?: { uuid: string; name: string }
  otherDatabases: Array<{ uuid: string; name: string }>
  namespaces: Array<{ id: string; title: string }>
  otherNamespaces: Array<{ id: string; title: string }>
  kvValues: Record<string, string>
  kvWrites: string[]
  catchAll?: Record<string, unknown> & {
    enabled?: boolean
    actions?: Array<{ type: "worker" | "forward" | "drop"; value?: string[] }>
    matchers?: Array<{ type: "all" }>
  }
  catchAllError?: Error
  deleted: string[]
} = {
  tokenStatus: { status: "active" },
  verifiers: [],
  resourceReads: 0,
  zones: [],
  botManagement: { fight_mode: false },
  botManagementReads: 0,
  wafEntryPoint: undefined,
  wafUpdates: [],
  workerScripts: [],
  workerRoutes: [],
  otherDatabases: [],
  namespaces: [],
  otherNamespaces: [],
  kvValues: {},
  kvWrites: [],
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

  botManagement = {
    get: async () => {
      cloudflareState.botManagementReads++
      return cloudflareState.botManagement
    },
  }

  rulesets = {
    phases: {
      get: async () => {
        if (!cloudflareState.wafEntryPoint) throw new MockNotFoundError()
        return cloudflareState.wafEntryPoint
      },
      update: async (_phase: string, input: { name: string; description?: string; rules: Array<Record<string, unknown>> }) => {
        cloudflareState.wafUpdates.push(input)
        cloudflareState.wafEntryPoint = input
        return input
      },
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
      values: {
        get: async (_namespaceId: string, key: string) => {
          const value = cloudflareState.kvValues[key]
          if (value === undefined) throw new MockNotFoundError()
          return new Response(value)
        },
        update: async (_namespaceId: string, key: string, params: { value: string }) => {
          cloudflareState.kvValues[key] = params.value
          cloudflareState.kvWrites.push(key)
          return {}
        },
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
          if (cloudflareState.catchAllError) throw cloudflareState.catchAllError
          if (!cloudflareState.catchAll) throw new MockNotFoundError()
          return cloudflareState.catchAll
        },
        update: async (args: Record<string, unknown>) => {
          cloudflareState.deleted.push(args.enabled === false ? "catch-all:disable" : "catch-all:restore")
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

const importCwd = mock.method(process, "cwd", () => fixtureDirectory)
let deleteProjectResources: typeof import("../scripts/deploy/delete").deleteProjectResources
let verifyCloudflareDeployAccess: typeof import("../scripts/deploy/cloudflare").verifyCloudflareDeployAccess
try {
  const [deleteModule, cloudflareModule] = await Promise.all([
    import("../scripts/deploy/delete"),
    import("../scripts/deploy/cloudflare"),
  ])
  deleteProjectResources = deleteModule.deleteProjectResources
  verifyCloudflareDeployAccess = cloudflareModule.verifyCloudflareDeployAccess
} finally {
  importCwd.mock.restore()
}

async function inFixtureDirectory<T>(callback: () => T | Promise<T>): Promise<T> {
  const cwdMock = mock.method(process, "cwd", () => fixtureDirectory)
  try {
    return await callback()
  } finally {
    cwdMock.mock.restore()
  }
}

function deleteFixtureResources() {
  return inFixtureDirectory(() => deleteProjectResources())
}

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
  cloudflareState.botManagement = { fight_mode: false }
  cloudflareState.botManagementReads = 0
  cloudflareState.wafEntryPoint = undefined
  cloudflareState.wafUpdates = []
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
  cloudflareState.kvValues = {}
  cloudflareState.kvWrites = []
  cloudflareState.catchAll = {
    enabled: true,
    actions: [{ type: "worker", value: ["email-receiver-worker"] }],
    matchers: [{ type: "all" }],
    name: "NextMail Catch All",
  }
  cloudflareState.catchAllError = undefined
  cloudflareState.deleted = []
  process.env.CLOUDFLARE_ACCOUNT_ID = "synthetic-account"
  process.env.CLOUDFLARE_API_TOKEN = "synthetic-token"
  process.env.EMAIL_DOMAIN = "example.invalid"
  process.env.CUSTOM_DOMAIN = "app.example.invalid"
  delete process.env.DATABASE_ID
  delete process.env.KV_NAMESPACE_ID
}

test("cleanup restores the Catch-all rule that the deployment recorded", async () => {
  resetCloudflareState()
  // The zone had a forwarding rule before the project took over the Catch-all.
  const previousRule = {
    enabled: true,
    actions: [{ type: "forward" as const, value: ["owner@example.invalid"] }],
    matchers: [{ type: "all" as const }],
    name: "Zone owner forwarding",
  }
  cloudflareState.catchAll = previousRule
  const { recordPreviousCatchAll } = await import("../scripts/deploy/cloudflare")

  await recordPreviousCatchAll("project-kv", "zone-project", previousRule)

  const backupKey = "PREVIOUS_CATCH_ALL_RULE:zone-project"
  assert.deepEqual(cloudflareState.kvWrites, [backupKey])
  const stored = JSON.parse(cloudflareState.kvValues[backupKey]) as { zoneId: string; rule: Record<string, unknown> }
  assert.equal(stored.zoneId, "zone-project")
  assert.deepEqual(stored.rule.actions, previousRule.actions)
  assert.deepEqual(stored.rule.matchers, previousRule.matchers)
  assert.equal(stored.rule.enabled, true)
  assert.equal(stored.rule.name, "Zone owner forwarding")

  // A later deployment must not replace the recorded zone rule with the project's own.
  await recordPreviousCatchAll("project-kv", "zone-project", {
    enabled: true,
    actions: [{ type: "worker", value: ["email-receiver-worker"] }],
    matchers: [{ type: "all" }],
    name: "NextMail Catch All",
  })
  assert.deepEqual(cloudflareState.kvWrites, [backupKey])
  assert.deepEqual(
    (JSON.parse(cloudflareState.kvValues[backupKey]) as { rule: { actions: unknown } }).rule.actions,
    previousRule.actions,
  )

  // The project Catch-all is in place when the cleanup runs.
  cloudflareState.catchAll = {
    enabled: true,
    actions: [{ type: "worker", value: ["email-receiver-worker"] }],
    matchers: [{ type: "all" }],
    name: "NextMail Catch All",
  }

  await deleteFixtureResources()

  assert.equal(cloudflareState.catchAll?.enabled, true)
  assert.deepEqual(cloudflareState.catchAll?.actions, previousRule.actions)
  assert.equal(cloudflareState.catchAll?.name, "Zone owner forwarding")
  assert.equal(cloudflareState.deleted.includes("catch-all:disable"), false)
})

test("upgrades never record the project's own Catch-all as its predecessor", async () => {
  resetCloudflareState()
  const { recordPreviousCatchAll } = await import("../scripts/deploy/cloudflare")

  assert.equal(await recordPreviousCatchAll("project-kv", "zone-project", cloudflareState.catchAll!), true)
  assert.deepEqual(JSON.parse(cloudflareState.kvValues["PREVIOUS_CATCH_ALL_RULE:zone-project"]), {
    zoneId: "zone-project", rule: null,
  })
  assert.equal(await recordPreviousCatchAll("project-kv", "zone-project", cloudflareState.catchAll!), false)
  await deleteFixtureResources()

  assert.equal(cloudflareState.catchAll?.enabled, false)
  assert.equal(cloudflareState.deleted.includes("catch-all:restore"), false)
})

test("an initially absent Catch-all remains absent through later deployments", async () => {
  resetCloudflareState()
  const { recordPreviousCatchAll, readPreviousCatchAll } = await import("../scripts/deploy/cloudflare")

  assert.equal(await recordPreviousCatchAll("project-kv", "zone-project", null), true)
  assert.equal(await recordPreviousCatchAll("project-kv", "zone-project", cloudflareState.catchAll!), false)
  assert.deepEqual(await readPreviousCatchAll("project-kv", "zone-project"), { zoneId: "zone-project", rule: null })
  await deleteFixtureResources()

  assert.equal(cloudflareState.catchAll?.enabled, false)
  assert.equal(cloudflareState.deleted.includes("catch-all:restore"), false)
})

test("Catch-all predecessors remain isolated when the deployment changes zones", async () => {
  resetCloudflareState()
  const { recordPreviousCatchAll, readPreviousCatchAll } = await import("../scripts/deploy/cloudflare")
  const first = { enabled: true, actions: [{ type: "forward" as const, value: ["first@example.invalid"] }], matchers: [{ type: "all" as const }] }
  const second = { ...first, actions: [{ type: "forward" as const, value: ["second@example.invalid"] }] }

  await recordPreviousCatchAll("project-kv", "zone-first", first)
  await recordPreviousCatchAll("project-kv", "zone-project", second)
  assert.deepEqual((await readPreviousCatchAll("project-kv", "zone-first"))?.rule?.actions, first.actions)
  await deleteFixtureResources()

  assert.deepEqual(cloudflareState.catchAll?.actions, second.actions)
})

test("cleanup ignores legacy, foreign-zone and project-owned Catch-all backups", async () => {
  const { restoreEmailCatchAll } = await import("../scripts/deploy/cloudflare")
  const rule = { enabled: true, actions: [{ type: "forward", value: ["foreign@example.invalid"] }], matchers: [{ type: "all" }] }
  for (const backup of [undefined, { zoneId: "zone-foreign", rule }, {
    zoneId: "zone-project", rule: { ...rule, actions: [{ type: "worker", value: ["email-receiver-worker"] }] },
  }]) {
    resetCloudflareState()
    cloudflareState.kvValues.PREVIOUS_CATCH_ALL_RULE = JSON.stringify(rule)
    if (backup) cloudflareState.kvValues["PREVIOUS_CATCH_ALL_RULE:zone-project"] = JSON.stringify(backup)
    await deleteFixtureResources()
    assert.equal(cloudflareState.catchAll?.enabled, false)
    assert.equal(cloudflareState.deleted.includes("catch-all:restore"), false)
  }
  assert.throws(() => restoreEmailCatchAll("zone-project", { zoneId: "zone-foreign", rule }), /this zone/)
})

test("cleanup disables the Catch-all when no previous rule was recorded", async () => {
  resetCloudflareState()

  await deleteFixtureResources()

  assert.ok(cloudflareState.deleted.includes("catch-all:disable"))
  assert.equal(cloudflareState.catchAll?.enabled, false)
})

test("a zone without a Catch-all rule is reported as missing instead of aborting", async () => {
  resetCloudflareState()
  // A zone that never used Email Routing has no Catch-all rule at all.
  cloudflareState.catchAll = undefined
  const { getEmailCatchAll } = await import("../scripts/deploy/cloudflare")

  const rule = await getEmailCatchAll("zone-project")

  assert.equal(rule, null)

  // Any other failure must still surface instead of being swallowed.
  cloudflareState.catchAllError = new Error("catch-all lookup failed")
  await assert.rejects(getEmailCatchAll("zone-project"), /catch-all lookup failed/)
})

test("cleanup deletes only identified NextMail Cloudflare resources", async () => {
  resetCloudflareState()

  await deleteFixtureResources()

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

  await assert.rejects(deleteFixtureResources(), /not currently usable/)
  assert.deepEqual(cloudflareState.deleted, [])
  assert.deepEqual(cloudflareState.verifiers, ["user"])
  assert.equal(cloudflareState.resourceReads, 0)
})

test("cleanup removes configured routes when CUSTOM_DOMAIN is unset", async () => {
  resetCloudflareState()
  delete process.env.CUSTOM_DOMAIN

  await deleteFixtureResources()

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

test("deployment WAF preflight refuses standard Bot Fight Mode before building or changing the ruleset", async () => {
  resetCloudflareState()
  cloudflareState.botManagement = { fight_mode: false, stale_zone_configuration: { fight_mode: true } }

  await assert.rejects(
    verifyCloudflareDeployAccess({
      emailDomain: "example.invalid",
      customDomain: "app.example.invalid",
      manageOpenApiWaf: true,
    }),
    /Bot Fight Mode cannot be skipped/,
  )
  assert.equal(cloudflareState.botManagementReads, 1)
  assert.deepEqual(cloudflareState.wafUpdates, [])
})

test("cleanup accepts an active account-owned token", async () => {
  resetCloudflareState()
  cloudflareState.userTokenError = new Error("Not a user-owned token")

  await deleteFixtureResources()

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

  await assert.rejects(deleteFixtureResources(), /does not point to the project database/)
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

  await assert.doesNotReject(deleteFixtureResources())
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
const buildCandidate = mock.fn(() => {
  assert.equal(process.env.OPENAPI_WAF_VERIFY_SECRET, undefined)
  throw stoppedAtBuild
})
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
    process.env.NEXT_PUBLIC_BASE_URL = "https://app.example.invalid"
    process.env.OPENAPI_WAF_VERIFY_SECRET = "0123456789abcdef0123456789abcdef"
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

    await assert.rejects(inFixtureDirectory(() => main()), error => error === stoppedAtBuild)

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
