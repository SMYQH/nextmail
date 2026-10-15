import test, { mock } from "node:test"
import assert from "node:assert/strict"

const cloudflareState: {
  zones: Array<{ id: string; name: string }>
  catchAllUpdates: Array<Record<string, unknown>>
} = {
  zones: [{ id: "synthetic-apex-zone", name: "example.invalid" }],
  catchAllUpdates: [],
}

class MockCloudflare {
  zones = {
    list: async function* () {
      yield* cloudflareState.zones
    },
  }
  emailRouting = {
    rules: {
      catchAlls: {
        update: async (args: Record<string, unknown>) => {
          cloudflareState.catchAllUpdates.push(args)
          return args
        },
      },
    },
  }
}

class MockNotFoundError extends Error {}

mock.module("cloudflare", { defaultExport: MockCloudflare, namedExports: { NotFoundError: MockNotFoundError } })
const { configureEmailCatchAll, getEmailCatchAllZone } = await import("../scripts/deploy/cloudflare")

test("subdomain EMAIL_DOMAIN cannot change the parent Zone catch-all", async t => {
  const original = process.env.EMAIL_DOMAIN
  t.after(() => {
    if (original === undefined) delete process.env.EMAIL_DOMAIN
    else process.env.EMAIL_DOMAIN = original
  })
  process.env.EMAIL_DOMAIN = "mail.example.invalid"
  cloudflareState.catchAllUpdates.length = 0

  await assert.rejects(getEmailCatchAllZone(), /subdomain of Cloudflare Zone example\.invalid/)
  assert.deepEqual(cloudflareState.catchAllUpdates, [])
})

test("apex EMAIL_DOMAIN updates only its exact Zone catch-all", async t => {
  const original = process.env.EMAIL_DOMAIN
  t.after(() => {
    if (original === undefined) delete process.env.EMAIL_DOMAIN
    else process.env.EMAIL_DOMAIN = original
  })
  process.env.EMAIL_DOMAIN = "example.invalid"
  cloudflareState.catchAllUpdates.length = 0

  const target = await getEmailCatchAllZone()
  await configureEmailCatchAll(target)
  assert.deepEqual(cloudflareState.catchAllUpdates, [{
    zone_id: "synthetic-apex-zone",
    actions: [{ type: "worker", value: ["email-receiver-worker"] }],
    matchers: [{ type: "all" }],
    enabled: true,
    name: "NextMail Catch All -> email-receiver-worker",
  }])
})

test("subdomain EMAIL_DOMAIN uses its own exact Zone when one is available", async t => {
  const original = process.env.EMAIL_DOMAIN
  const originalZones = cloudflareState.zones
  t.after(() => {
    if (original === undefined) delete process.env.EMAIL_DOMAIN
    else process.env.EMAIL_DOMAIN = original
    cloudflareState.zones = originalZones
  })
  process.env.EMAIL_DOMAIN = "mail.example.invalid"
  cloudflareState.zones = [
    { id: "synthetic-apex-zone", name: "example.invalid" },
    { id: "synthetic-subdomain-zone", name: "mail.example.invalid" },
  ]
  cloudflareState.catchAllUpdates.length = 0

  const target = await getEmailCatchAllZone()
  assert.equal(target.zone.id, "synthetic-subdomain-zone")
  await configureEmailCatchAll(target)
  assert.equal(cloudflareState.catchAllUpdates[0]?.zone_id, "synthetic-subdomain-zone")
})
