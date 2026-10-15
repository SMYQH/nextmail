import test, { after, beforeEach, mock, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { DrizzleQueryError } from "drizzle-orm/errors"
import { drizzle } from "drizzle-orm/d1"
import * as schema from "../app/lib/schema"
import { createTestDatabase } from "./helpers/database"
import { PERMISSIONS } from "../app/lib/permissions"

const { sqlite, d1 } = createTestDatabase()
const db = drizzle(d1, { schema })
let requestHeaders = new Headers()
let sessionId: string | undefined
let sessionRole = "duke"
const config = new Map<string, string>()

mock.module("../app/lib/db.ts", { namedExports: { createDb: () => db } })
mock.module("next/headers", { namedExports: { headers: async () => requestHeaders } })
mock.module("@opennextjs/cloudflare", { namedExports: { getCloudflareContext: () => ({ env: { DB: d1, SITE_CONFIG: { get: async (key: string) => config.get(key) ?? null, put: async (key: string, value: string) => { config.set(key, value) } } } }) } })
mock.module("../app/lib/auth.ts", { namedExports: { GET: async () => Response.json(sessionId ? { user: { id: sessionId } } : null), auth: async () => sessionId ? { user: { id: sessionId } } : null, getUserRole: async () => sessionRole, checkPermission: async () => sessionId === "owner" } })

const { getUserId } = await import("../app/lib/apiKey")
const siteConfig = await import("../app/api/config/route")
const generate = await import("../app/api/emails/generate/route")
const rolesUsers = await import("../app/api/roles/users/route")
const userDomains = await import("../app/api/roles/user-domains/route")
const webhook = await import("../app/api/webhook/route")
const webhookTest = await import("../app/api/webhook/test/route")
const detail = await import("../app/api/emails/[id]/[messageId]/route")
const shares = await import("../app/api/emails/[id]/share/route")
const messageShares = await import("../app/api/emails/[id]/messages/[messageId]/share/route")
const revokeMessageShare = await import("../app/api/emails/[id]/messages/[messageId]/share/[shareId]/route")
const publicMessage = await import("../app/api/shared/message/[token]/route")
const publicMailboxMessage = await import("../app/api/shared/[token]/messages/[messageId]/route")
const emailService = await import("../app/api/config/email-service/route")
const send = await import("../app/api/emails/[id]/send/route")
const sendPermission = await import("../app/api/emails/send-permission/route")
const apiKeysRoute = await import("../app/api/api-keys/route")
const init = await import("../app/api/roles/init-emperor/route")

function reset() {
  config.clear()
  config.set("EMAIL_SERVICE_ENABLED", "true")
  config.set("EMAIL_ROLE_LIMITS", '{"duke":2,"knight":-1}')
  config.set("RESEND_API_KEY", "test-only")
  sqlite.exec("DELETE FROM api_keys; DELETE FROM user_email_domain_access; DELETE FROM user; DELETE FROM role")
  sqlite.exec("INSERT INTO user(id) VALUES('owner'),('victim'); INSERT INTO role(id,name) VALUES('duke','duke'),('civilian','civilian'),('knight','knight'),('emperor','emperor'); INSERT INTO user_role(user_id,role_id) VALUES('owner','duke')")
  sqlite.prepare("INSERT INTO email(id,address,userId,created_at,expires_at) VALUES('email','owner@example.com','owner',0,?)").run(Date.now() + 60_000)
  sqlite.exec("INSERT INTO message(id,emailId,subject,content,html,received_at,sent_at,type) VALUES('message','email','Subject','secret','',100,200,'received')")
  requestHeaders = new Headers()
  sessionId = "owner"
  sessionRole = "duke"
}
beforeEach(t => {
  assert.ok("mock" in t)
  reset()
  const network = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected outbound request in route test")
  })
  t.after(() => assert.equal(network.mock.callCount(), 0, "Network calls must be explicitly mocked"))
})
after(() => sqlite.close())
const request = () => new Request("https://app.example.com/api/emails/email/message")
const params = () => ({ params: Promise.resolve({ id: "email", messageId: "message" }) })
const sendParams = (id = "email") => ({ params: Promise.resolve({ id }) })
const sendRequest = (body: unknown = { to: "a@example.com", subject: "Subject", content: "<p>Hello</p>" }) =>
  new Request(request(), { method: "POST", body: JSON.stringify(body) })
const usedQuota = () => sqlite.prepare("SELECT COALESCE(SUM(used), 0) AS n FROM send_usage").get()?.n
const sentCount = () => sqlite.prepare("SELECT COUNT(*) AS n FROM message WHERE type = 'sent'").get()?.n

function setWebhookEnvironment(t: TestContext, value: string) {
  const previous = process.env.WEBHOOK_ALLOWED_HOSTS
  process.env.WEBHOOK_ALLOWED_HOSTS = value
  t.after(() => {
    if (previous === undefined) delete process.env.WEBHOOK_ALLOWED_HOSTS
    else process.env.WEBHOOK_ALLOWED_HOSTS = previous
  })
}

test("mailbox creation normalizes legacy domains and configuration saves", async () => {
  config.set("EMAIL_DOMAINS", "example.com, EXAMPLE.org , example.com")
  const settings = await (await siteConfig.GET()).json() as { emailDomains: string }
  assert.equal(settings.emailDomains, "example.com,example.org")
  const response = await generate.POST(new Request(request(), { method: "POST", body: JSON.stringify({ name: "Alice", domain: "example.org", expiryTime: 0 }) }))
  assert.equal(response.status, 200)
  assert.equal((await response.json() as { email: string }).email, "alice@example.org")
  const save = (emailDomains: string) => siteConfig.POST(new Request(request(), { method: "POST", body: JSON.stringify({ defaultRole: "duke", emailDomains, adminContact: "", maxEmails: "10" }) }))
  assert.equal((await save(" example.NET, EXAMPLE.com , example.net ")).status, 200)
  assert.equal(config.get("EMAIL_DOMAINS"), "example.net,example.com")
  assert.equal((await save(" , ")).status, 400)
  assert.equal(config.get("EMAIL_DOMAINS"), "example.net,example.com")
})

test("mailbox creation trims valid names and persists a normalized address", async () => {
  config.set("EMAIL_DOMAINS", "example.com")
  const response = await generate.POST(new Request(request(), {
    method: "POST", body: JSON.stringify({ name: " Alice.Tag+news ", domain: "example.com", expiryTime: 0 }),
  }))
  assert.equal(response.status, 200)
  const body = await response.json() as { id: string; email: string }
  assert.equal(body.email, "alice.tag+news@example.com")
  assert.equal(sqlite.prepare("SELECT address FROM email WHERE id = ?").get(body.id)?.address, body.email)
})

test("mailbox creation enforces user domain access and leaves Emperor access unrestricted", async () => {
  config.set("EMAIL_DOMAINS", "example.com, example.org")
  sqlite.prepare("INSERT INTO user_email_domain_access(user_id,domains) VALUES('owner',?)").run(JSON.stringify(["example.org"]))

  const before = sqlite.prepare("SELECT COUNT(*) AS n FROM email").get()?.n
  const denied = await generate.POST(new Request(request(), {
    method: "POST", body: JSON.stringify({ name: "notallowed", domain: "example.com", expiryTime: 0 }),
  }))
  assert.equal(denied.status, 403)
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM email").get()?.n, before)
  assert.deepEqual((await (await siteConfig.GET()).json() as { availableEmailDomains: string[] }).availableEmailDomains, ["example.org"])

  const allowed = await generate.POST(new Request(request(), {
    method: "POST", body: JSON.stringify({ name: "allowed", domain: "example.org", expiryTime: 0 }),
  }))
  assert.equal(allowed.status, 200)

  sessionRole = "emperor"
  const emperor = await generate.POST(new Request(request(), {
    method: "POST", body: JSON.stringify({ name: "emperor", domain: "example.com", expiryTime: 0 }),
  }))
  assert.equal(emperor.status, 200)
})

test("Emperor can update a user's allowed domains without accepting unconfigured domains", async () => {
  config.set("EMAIL_DOMAINS", "example.com, example.org")
  sessionRole = "emperor"
  const update = (allowedDomains: unknown) => userDomains.PATCH(new Request(request(), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: "victim", allowedDomains }),
  }))

  sessionId = "victim"
  assert.equal((await update(["example.org"])).status, 403)
  sessionId = "owner"

  const saved = await update([" EXAMPLE.org ", "example.org"])
  assert.equal(saved.status, 200)
  assert.deepEqual(JSON.parse(String(sqlite.prepare("SELECT domains FROM user_email_domain_access WHERE user_id = 'victim'").get()?.domains)), ["example.org"])

  const listed = await (await rolesUsers.GET(new Request("https://app.example.com/api/roles/users"))).json() as {
    users: Array<{ id: string; allowedDomains: string[] | null }>
  }
  assert.deepEqual(listed.users.find(user => user.id === "victim")?.allowedDomains, ["example.org"])

  const invalid = await update(["unconfigured.example"])
  assert.equal(invalid.status, 400)
  assert.deepEqual(JSON.parse(String(sqlite.prepare("SELECT domains FROM user_email_domain_access WHERE user_id = 'victim'").get()?.domains)), ["example.org"])

  const resetAccess = await update(null)
  assert.equal(resetAccess.status, 200)
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM user_email_domain_access WHERE user_id = 'victim'").get()?.n, 0)
})

test("invalid mailbox names never create a mailbox", async () => {
  config.set("EMAIL_DOMAINS", "example.com")
  for (const name of ["alice bob", "alice@elsewhere.com", ".alice", "alice.", "alice..bob", "a".repeat(65), "alice\nbob", 42, null, {}]) {
    const before = sqlite.prepare("SELECT COUNT(*) AS n FROM email").get()?.n
    const response = await generate.POST(new Request(request(), {
      method: "POST", body: JSON.stringify({ name, domain: "example.com", expiryTime: 0 }),
    }))
    assert.equal(response.status, 400, JSON.stringify(name))
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM email").get()?.n, before)
  }
})

test("omitted and blank mailbox names preserve random address generation", async () => {
  config.set("EMAIL_DOMAINS", "example.com")
  for (const name of [undefined, "", "   "]) {
    const response = await generate.POST(new Request(request(), {
      method: "POST", body: JSON.stringify({ name, domain: "example.com", expiryTime: 0 }),
    }))
    assert.equal(response.status, 200)
    const body = await response.json() as { id: string; email: string }
    assert.match(body.email, /^[a-z0-9_-]{8}@example\.com$/)
    assert.equal(sqlite.prepare("SELECT address FROM email WHERE id = ?").get(body.id)?.address, body.email)
  }
})

test("unconfigured email domains advertise no fallback and never create mailboxes", async () => {
  for (const value of [undefined, "", " , "]) {
    if (value === undefined) config.delete("EMAIL_DOMAINS")
    else config.set("EMAIL_DOMAINS", value)
    assert.equal((await (await siteConfig.GET()).json() as { emailDomains: string }).emailDomains, "")
    const before = sqlite.prepare("SELECT COUNT(*) AS n FROM email").get()?.n
    const response = await generate.POST(new Request(request(), { method: "POST", body: JSON.stringify({ name: "reviewonly", domain: "nextmail.pages.dev", expiryTime: 0 }) }))
    assert.equal(response.status, 503)
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM email").get()?.n, before)
  }
})

test("webhook setup failures are actionable and never prevent disabling an existing webhook", async t => {
  setWebhookEnvironment(t, "")
  sqlite.exec("INSERT INTO webhook(id,user_id,url,secret,enabled,created_at,updated_at) VALUES('w','owner','https://hooks.example.com/event','secret',1,0,0)")
  const update = (enabled: boolean) => webhook.POST(new Request(request(), { method: "POST", body: JSON.stringify({ url: "https://hooks.example.com/event", enabled }) }))
  const existing = await (await webhook.GET()).json() as { enabled: boolean; setupError: string }
  assert.equal(existing.enabled, true)
  assert.equal(existing.setupError, "setupRequired")
  const rejected = await update(true)
  assert.equal(rejected.status, 400)
  assert.deepEqual(await rejected.json(), { error: "setupRequired" })
  assert.equal((await update(false)).status, 200)
  assert.equal(sqlite.prepare("SELECT enabled FROM webhook WHERE id = 'w'").get()?.enabled, 0)
})

test("approved webhook hosts can be saved and tested while other hosts remain blocked", async t => {
  setWebhookEnvironment(t, "hooks.example.com")
  let deliveries = 0
  t.mock.method(globalThis, "fetch", async () => { deliveries++; return new Response(null, { status: 204 }) })
  const makeRequest = (url: string) => new Request(request(), { method: "POST", body: JSON.stringify({ url, enabled: true }) })
  const url = "https://hooks.example.com/event"
  assert.equal((await webhook.POST(makeRequest(url))).status, 200)
  assert.equal((await webhookTest.POST(makeRequest(url))).status, 200)
  const rejected = await webhookTest.POST(makeRequest("https://other.example.com/event"))
  assert.equal(rejected.status, 400)
  assert.deepEqual(await rejected.json(), { error: "hostNotAllowed" })
  assert.equal(deliveries, 1)
})

test("forged identity headers never replace a verified session or create one", async () => {
  requestHeaders.set("X-User-Id", "victim")
  assert.equal(await getUserId(), "owner")
  sessionId = undefined
  assert.equal(await getUserId(), undefined)
})

test("API keys lose access after demotion, disablement or expiry", async () => {
  sqlite.prepare("INSERT INTO api_keys(id,user_id,name,key,enabled,expires_at) VALUES('key','owner','test','test-key',1,?)").run(Math.floor(Date.now() / 1000) + 3600)
  requestHeaders.set("X-API-Key", "test-key")
  assert.equal(await getUserId(PERMISSIONS.MANAGE_EMAIL), "owner")
  sqlite.exec("UPDATE user_role SET role_id = 'knight' WHERE user_id = 'owner'")
  assert.equal(await getUserId(PERMISSIONS.MANAGE_EMAIL), undefined)
  sqlite.exec("UPDATE user_role SET role_id = 'duke'; UPDATE api_keys SET enabled = 0")
  assert.equal(await getUserId(), undefined)
  sqlite.exec("UPDATE api_keys SET enabled = 1, expires_at = 0")
  assert.equal(await getUserId(), undefined)
})

test("expired mailboxes reject message reads, shares and sends before external calls", async t => {
  sqlite.exec("UPDATE email SET expires_at = 0")
  const provider = t.mock.method(globalThis, "fetch", async () => { throw new Error("Must not contact provider") })
  assert.equal((await detail.GET(request(), params())).status, 403)
  assert.equal((await shares.POST(new Request(request(), { method: "POST", body: '{"expiresIn":0}' }), params())).status, 404)
  assert.equal((await send.POST(new Request(request(), { method: "POST", body: '{"to":"a@example.com","subject":"s","content":"c"}' }), params())).status, 404)
  assert.equal(provider.mock.callCount(), 0)
  assert.equal(usedQuota(), 0)
})

test("sent-message detail checks current send permission and uses sent_at", async () => {
  sqlite.exec("UPDATE message SET type = 'sent'")
  const response = await detail.GET(request(), params())
  const body = await response.json() as { message: { sent_at: number } }
  assert.equal(body.message.sent_at, 200)
  sqlite.exec("UPDATE user_role SET role_id = 'knight'")
  assert.equal((await detail.GET(request(), params())).status, 403)
})

test("concurrent send requests reserve quota before contacting the provider", async t => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const observedUsage: unknown[] = []
  const provider = t.mock.method(globalThis, "fetch", async () => {
    observedUsage.push(usedQuota())
    await held
    return Response.json({ id: "sent" })
  })
  const pending = Array.from({ length: 8 }, () => send.POST(sendRequest(), params()))
  try {
    // Let route handlers reach the provider; hold both deliveries while other requests compete.
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(provider.mock.callCount(), 2)
    assert.equal(usedQuota(), 2)
    assert.equal(sentCount(), 0)
    assert.ok(observedUsage.every(value => typeof value === "number" && value >= 1 && value <= 2))
  } finally {
    release()
    await Promise.allSettled(pending)
  }
  const responses = await Promise.all(pending)
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 200, 403, 403, 403, 403, 403, 403])
  const successes = await Promise.all(responses.filter(response => response.ok).map(response => response.json() as Promise<{ remainingEmails: number }>))
  assert.deepEqual(successes.map(body => body.remainingEmails).sort(), [0, 1])
  assert.equal(sentCount(), 2)
  sqlite.exec("DELETE FROM message")
  assert.equal((await send.POST(sendRequest(), params())).status, 403)
  assert.equal(provider.mock.callCount(), 2)
  assert.equal(usedQuota(), 2)
})

test("owners can discover and revoke sent-message shares after losing send permission", async t => {
  for (const reason of ["service disabled", "role demoted"]) {
    await t.test(reason, async () => {
      reset()
      sqlite.exec("UPDATE message SET type = 'sent'; INSERT INTO message_share(id,message_id,token,created_at) VALUES('share','message','public-token',0)")
      if (reason === "service disabled") config.set("EMAIL_SERVICE_ENABLED", "false")
      else sqlite.exec("UPDATE user_role SET role_id = 'knight'")

      const publicParams = { params: Promise.resolve({ token: "public-token" }) }
      const revokeParams = { params: Promise.resolve({ id: "email", messageId: "message", shareId: "share" }) }
      assert.equal((await publicMessage.GET(request(), publicParams)).status, 200)
      const listed = await messageShares.GET(request(), params())
      assert.equal(listed.status, 200)
      assert.equal((await listed.json() as { shares: { id: string }[] }).shares[0].id, "share")
      assert.equal((await messageShares.POST(new Request(request(), { method: "POST", body: '{"expiresIn":0}' }), params())).status, 403)

      sessionId = "victim"
      assert.equal((await revokeMessageShare.DELETE(request(), revokeParams)).status, 401)
      sqlite.exec("INSERT INTO user_role(user_id,role_id) VALUES('victim','knight')")
      assert.equal((await revokeMessageShare.DELETE(request(), revokeParams)).status, 403)
      sessionId = "owner"
      assert.equal((await revokeMessageShare.DELETE(request(), { params: Promise.resolve({ id: "email", messageId: "missing", shareId: "share" }) })).status, 404)
      assert.equal((await revokeMessageShare.DELETE(request(), revokeParams)).status, 200)
      assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM message_share").get()?.n, 0)
      assert.equal((await publicMessage.GET(request(), publicParams)).status, 404)
    })
  }
})

test("GET initializes the emperor, while unauthenticated GET and HEAD do not change roles", async () => {
  const before = sqlite.prepare("SELECT user_id, role_id FROM user_role ORDER BY user_id, role_id").all().map(row => ({ ...row }))
  const response = await init.GET()
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { message: "Emperor initialized" })
  assert.deepEqual(
    sqlite.prepare("SELECT user_id, role_id FROM user_role ORDER BY user_id, role_id").all().map(row => ({ ...row })),
    [{ user_id: "owner", role_id: "emperor" }],
  )

  sessionId = undefined
  assert.equal((await init.GET()).status, 401)
  const head = await init.HEAD()
  assert.equal(head.status, 405)
  assert.equal(head.headers.get("allow"), "GET, POST, OPTIONS")
  const options = await init.OPTIONS()
  assert.equal(options.status, 204)
  assert.equal(options.headers.get("allow"), "GET, POST, OPTIONS")
  assert.deepEqual(
    sqlite.prepare("SELECT user_id, role_id FROM user_role ORDER BY user_id, role_id").all().map(row => ({ ...row })),
    [{ user_id: "owner", role_id: "emperor" }],
  )
  sqlite.exec("UPDATE user_role SET role_id = 'duke' WHERE user_id = 'owner'")
  assert.deepEqual(
    sqlite.prepare("SELECT user_id, role_id FROM user_role ORDER BY user_id, role_id").all().map(row => ({ ...row })),
    before,
  )
})

test("emperor initialization rejects unauthenticated claims without changing roles", async () => {
  sessionId = undefined
  const before = sqlite.prepare("SELECT * FROM user_role ORDER BY user_id, role_id").all()
  assert.equal((await init.POST()).status, 401)
  assert.deepEqual(sqlite.prepare("SELECT * FROM user_role ORDER BY user_id, role_id").all(), before)
})

test("emperor initialization uses an atomic claim and leaves losers' roles unchanged", async () => {
  sqlite.exec("INSERT INTO user_role(user_id,role_id) VALUES('victim','knight')")
  assert.equal((await init.POST()).status, 200)
  sessionId = "victim"
  assert.equal((await init.POST()).status, 409)
  assert.equal(sqlite.prepare("SELECT user_id FROM user_role WHERE role_id = 'emperor'").get()?.user_id, "owner")
  assert.deepEqual(sqlite.prepare("SELECT role_id FROM user_role WHERE user_id = 'owner'").all().map(row => row.role_id), ["emperor"])
  assert.deepEqual(sqlite.prepare("SELECT role_id FROM user_role WHERE user_id = 'victim'").all().map(row => row.role_id), ["knight"])
})

test("public message shares stop exposing content when the share or mailbox expires", async t => {
  const now = 1_800_000_000_000
  t.mock.timers.enable({ apis: ["Date"], now })
  for (const scenario of [
    { name: "active", status: 200 },
    { name: "expired mailbox", status: 410 },
    { name: "mailbox expires now", status: 410 },
    { name: "expired share", status: 410 },
    { name: "share expires now", status: 410 },
    { name: "revoked share", status: 404 },
    { name: "unknown token", status: 404 },
    { name: "deleted message", status: 404 },
    { name: "deleted mailbox", status: 404 },
  ]) {
    await t.test(scenario.name, async () => {
      reset()
      sessionId = undefined
      sqlite.exec("INSERT INTO message_share(id,message_id,token,created_at) VALUES('share','message','public-token',0)")
      if (scenario.name === "expired mailbox") sqlite.prepare("UPDATE email SET expires_at = ?").run(now - 1)
      if (scenario.name === "mailbox expires now") sqlite.prepare("UPDATE email SET expires_at = ?").run(now)
      if (scenario.name === "expired share") sqlite.prepare("UPDATE message_share SET expires_at = ?").run(now - 1)
      if (scenario.name === "share expires now") sqlite.prepare("UPDATE message_share SET expires_at = ?").run(now)
      if (scenario.name === "revoked share") sqlite.exec("DELETE FROM message_share")
      if (scenario.name === "deleted message") sqlite.exec("DELETE FROM message")
      if (scenario.name === "deleted mailbox") sqlite.exec("DELETE FROM email")
      const token = scenario.name === "unknown token" ? "unknown" : "public-token"
      const response = await publicMessage.GET(request(), { params: Promise.resolve({ token }) })
      assert.equal(response.status, scenario.status)
      const body = await response.json() as { message?: { id: string; content: string }; error?: string }
      if (scenario.status === 200) {
        assert.equal(body.message?.id, "message")
        assert.equal(body.message.content, "secret")
      } else {
        assert.equal(body.message, undefined)
        assert.equal(typeof body.error, "string")
        assert.equal(JSON.stringify(body).includes("secret"), false)
      }
    })
  }
})

test("mailbox shares do not expose sent messages through the detail endpoint", async () => {
  sessionId = undefined
  sqlite.exec("INSERT INTO email_share(id,email_id,token,created_at) VALUES('mailbox-share','email','mailbox-token',0)")
  sqlite.exec("INSERT INTO message(id,emailId,subject,content,html,received_at,sent_at,type) VALUES('sent-message','email','Private sent','private sent body','',100,200,'sent')")

  const response = await publicMailboxMessage.GET(request(), {
    params: Promise.resolve({ token: "mailbox-token", messageId: "sent-message" })
  })

  assert.equal(response.status, 404)
  const body = await response.json() as { message?: unknown; error?: string }
  assert.equal(body.message, undefined)
  assert.equal(JSON.stringify(body).includes("private sent body"), false)
})

test("invalid API keys never fall back to a valid session", async () => {
  for (const key of ["", "unknown-key"]) {
    requestHeaders.set("X-API-Key", key)
    assert.equal(await getUserId(PERMISSIONS.MANAGE_EMAIL), undefined)
  }
  requestHeaders.delete("X-API-Key")
  assert.equal(await getUserId(PERMISSIONS.MANAGE_EMAIL), "owner")
})

test("API key permissions are bounded even when the owner is emperor", async () => {
  sqlite.exec("UPDATE user_role SET role_id = 'emperor'")
  sqlite.prepare("INSERT INTO api_keys(id,user_id,name,key,enabled,expires_at) VALUES('key','owner','test','test-key',1,?)").run(Math.floor(Date.now() / 1000) + 3600)
  requestHeaders.set("X-API-Key", "test-key")
  assert.equal(await getUserId(PERMISSIONS.MANAGE_EMAIL), "owner")
  assert.equal(await getUserId(PERMISSIONS.MANAGE_CONFIG), "owner")
  for (const permission of [PERMISSIONS.MANAGE_API_KEY, PERMISSIONS.MANAGE_WEBHOOK, PERMISSIONS.PROMOTE_USER]) {
    assert.equal(await getUserId(permission), undefined, permission)
  }
})

test("per-domain Resend configuration uses each domain's own API key", async t => {
  config.set("EMAIL_DOMAINS", "example.com,other.example")
  const saved = await emailService.POST(new Request(request(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      domains: {
        "example.com": { enabled: true, apiKey: "example-key" },
        "other.example": { enabled: true, apiKey: "other-key" },
      },
      roleLimits: { duke: 2, knight: -1 },
    }),
  }))
  assert.equal(saved.status, 200)

  sqlite.prepare("INSERT INTO email(id,address,userId,created_at,expires_at) VALUES('other-email','owner@other.example','owner',0,?)")
    .run(Date.now() + 60_000)
  const authorizationHeaders: string[] = []
  t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    authorizationHeaders.push(new Headers(init?.headers).get("Authorization") ?? "")
    return Response.json({ id: "sent" })
  })

  assert.equal((await send.POST(sendRequest(), sendParams())).status, 200)
  assert.equal((await send.POST(sendRequest(), sendParams("other-email"))).status, 200)
  assert.deepEqual(authorizationHeaders, ["Bearer example-key", "Bearer other-key"])
  assert.deepEqual(JSON.parse(config.get("RESEND_CONFIG") ?? "{}"), {
    "example.com": { enabled: true, apiKey: "example-key" },
    "other.example": { enabled: true, apiKey: "other-key" },
  })

  const settings = await (await emailService.GET()).json() as {
    domains: Record<string, { apiKey: string; hasApiKey: boolean; configured: boolean }>
  }
  assert.equal(settings.domains["example.com"].apiKey, "")
  assert.equal(settings.domains["example.com"].hasApiKey, true)
  assert.equal(settings.domains["other.example"].configured, true)
})

test("legacy global Resend settings remain active until per-domain config is saved", async t => {
  config.set("EMAIL_DOMAINS", "example.com")
  const provider = t.mock.method(globalThis, "fetch", async () => Response.json({ id: "sent" }))

  assert.equal((await send.POST(sendRequest(), sendParams())).status, 200)
  assert.equal(new Headers(provider.mock.calls[0].arguments[1]?.headers).get("Authorization"), "Bearer test-only")
  assert.equal(config.has("RESEND_CONFIG"), false)

  const settings = await (await emailService.GET()).json() as {
    domains: Record<string, { enabled: boolean; hasApiKey: boolean }>
  }
  assert.equal(settings.domains["example.com"].enabled, true)
  assert.equal(settings.domains["example.com"].hasApiKey, true)
})

test("saved per-domain config denies sending from a removed domain", async t => {
  config.set("EMAIL_DOMAINS", "example.com")
  config.set("RESEND_CONFIG", JSON.stringify({
    "example.com": { enabled: true, apiKey: "example-key" },
  }))
  sqlite.prepare("INSERT INTO email(id,address,userId,created_at,expires_at) VALUES('removed-email','owner@removed.example','owner',0,?)")
    .run(Date.now() + 60_000)
  const provider = t.mock.method(globalThis, "fetch", async () => Response.json({ id: "unexpected" }))

  const response = await send.POST(sendRequest(), sendParams("removed-email"))
  assert.equal(response.status, 403)
  assert.equal(provider.mock.callCount(), 0)
  assert.equal(usedQuota(), 0)
})

test("Catch-all sender overrides require a valid prefix and a configured Catch-all mailbox", async () => {
  config.set("EMAIL_DOMAINS", "example.com")
  config.set("RESEND_CONFIG", JSON.stringify({
    "example.com": { enabled: true, apiKey: "example-key" },
  }))
  config.set("CATCHALL_EMAIL", JSON.stringify({
    "example.com": { address: "catch@example.com", enabled: true, showAlways: true },
  }))
  sqlite.exec("UPDATE email SET address = 'catch@example.com'; UPDATE user_role SET role_id = 'emperor' WHERE user_id = 'owner'")
  sessionRole = "emperor"

  const invalidPrefix = await send.POST(sendRequest({
    to: "a@example.com",
    subject: "Subject",
    content: "Hello",
    fromLocalPart: "invalid prefix",
  }), sendParams())
  assert.equal(invalidPrefix.status, 400)
  assert.equal(usedQuota(), 0)

  sqlite.exec("UPDATE email SET address = 'owner@example.com'")
  const ordinaryMailboxOverride = await send.POST(sendRequest({
    to: "a@example.com",
    subject: "Subject",
    content: "Hello",
    fromLocalPart: "spoofed",
  }), sendParams())
  assert.equal(ordinaryMailboxOverride.status, 403)
  assert.equal(usedQuota(), 0)
})

test("send permission is filtered by the mailbox domain", async () => {
  config.set("RESEND_CONFIG", JSON.stringify({
    "example.com": { enabled: true, apiKey: "example-key" },
    "other.example": { enabled: false, apiKey: "other-key" },
  }))

  const enabled = await sendPermission.GET(new Request("https://app.example.com/api/emails/send-permission?address=owner%40example.com"))
  const disabled = await sendPermission.GET(new Request("https://app.example.com/api/emails/send-permission?address=owner%40other.example"))
  assert.equal((await enabled.json() as { canSend: boolean }).canSend, true)
  assert.equal((await disabled.json() as { canSend: boolean }).canSend, false)
})

test("send rejects invalid input and unauthorized requests without quota or delivery side effects", async t => {
  for (const scenario of ["anonymous", "other owner", "civilian", "service disabled", "role forbidden", "missing recipient", "missing subject", "missing content", "missing mailbox"]) {
    await t.test(scenario, async () => {
      reset()
      let expected = 403
      const body = { to: "a@example.com", subject: "Subject", content: "Hello" }
      if (scenario === "anonymous") { sessionId = undefined; expected = 401 }
      if (scenario === "other owner") {
        sessionId = "victim"
        sqlite.exec("INSERT INTO user_role(user_id,role_id) VALUES('victim','duke')")
      }
      if (scenario === "civilian") { sqlite.exec("UPDATE user_role SET role_id = 'civilian'"); expected = 401 }
      if (scenario === "service disabled") config.set("EMAIL_SERVICE_ENABLED", "false")
      if (scenario === "role forbidden") sqlite.exec("UPDATE user_role SET role_id = 'knight'")
      if (scenario === "missing recipient") { body.to = ""; expected = 400 }
      if (scenario === "missing subject") { body.subject = ""; expected = 400 }
      if (scenario === "missing content") { body.content = ""; expected = 400 }
      if (scenario === "missing mailbox") { sqlite.exec("DELETE FROM email"); expected = 404 }
      const response = await send.POST(sendRequest(body), params())
      assert.equal(response.status, expected)
      assert.equal(typeof (await response.json() as { error: string }).error, "string")
      assert.equal(usedQuota(), 0)
      assert.equal(sentCount(), 0)
    })
  }
})

test("successful delivery stores the intended message and consumes one quota slot", async t => {
  const provider = t.mock.method(globalThis, "fetch", async () => Response.json({ id: "provider-id" }))
  const response = await send.POST(sendRequest(), params())
  assert.equal(response.status, 200)
  assert.equal((await response.json() as { remainingEmails: number }).remainingEmails, 1)
  assert.equal(provider.mock.callCount(), 1)
  const [url, options] = provider.mock.calls[0].arguments as [string, RequestInit]
  assert.equal(url, "https://api.resend.com/emails")
  assert.equal(options.method, "POST")
  assert.equal(new Headers(options.headers).get("Authorization"), "Bearer test-only")
  assert.deepEqual(JSON.parse(options.body as string), {
    from: "owner@example.com", to: ["a@example.com"], subject: "Subject", html: "<p>Hello</p>",
  })
  const stored = sqlite.prepare("SELECT emailId,from_address,to_address,subject,html,content FROM message WHERE type = 'sent'").get()
  assert.deepEqual({ ...stored }, {
    emailId: "email", from_address: "owner@example.com", to_address: "a@example.com", subject: "Subject", html: "<p>Hello</p>", content: "",
  })
  assert.equal(usedQuota(), 1)
})

test("definitive provider rejection refunds quota but ambiguous failures retain it", async t => {
  for (const failure of ["rejected", "server error", "timeout"]) {
    await t.test(failure, async t => {
      reset()
      t.mock.method(console, "error", () => {})
      const provider = t.mock.method(globalThis, "fetch", async () => {
        if (failure === "timeout") throw new DOMException("Timed out", "TimeoutError")
        return Response.json({ message: "Delivery failed" }, { status: failure === "rejected" ? 422 : 503 })
      })
      assert.equal((await send.POST(sendRequest(), params())).status, 500)
      assert.equal(provider.mock.callCount(), 1)
      assert.equal(usedQuota(), failure === "rejected" ? 0 : 1)
      assert.equal(sentCount(), 0)
      t.mock.method(globalThis, "fetch", async () => Response.json({ id: "retry" }))
      const retry = await send.POST(sendRequest(), params())
      assert.equal(retry.status, 200)
      assert.equal((await retry.json() as { remainingEmails: number }).remainingEmails, failure === "rejected" ? 1 : 0)
      assert.equal(sentCount(), 1)
    })
  }
})

test("API key persistence failures do not log submitted secrets or Drizzle parameters", async t => {
  const keyName = "synthetic-api-key-name-42d1"
  const keyValue = "synthetic-api-key-value-1e8a"
  const error = new DrizzleQueryError(
    'INSERT INTO "api_keys" ("name", "key") VALUES (?, ?)',
    [keyName, keyValue],
  )
  const originalPrepare = d1.prepare.bind(d1)
  t.mock.method(d1, "prepare", (sql: string) => {
    if (sql.toLowerCase().includes('insert into "api_keys"')) throw error
    return originalPrepare(sql)
  })

  const logged: unknown[][] = []
  t.mock.method(console, "error", (...values: Parameters<typeof console.error>) => { logged.push(values) })
  const response = await apiKeysRoute.POST(new Request("https://app.example.com/api/api-keys", {
    method: "POST",
    body: JSON.stringify({ name: keyName }),
  }))

  assert.equal(response.status, 500)
  assert.match(JSON.stringify(logged), /DrizzleQueryError/)
  assert.equal(JSON.stringify(logged).includes(keyName), false)
  assert.equal(JSON.stringify(logged).includes(keyValue), false)
})
