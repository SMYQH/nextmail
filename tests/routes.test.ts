import test, { after, beforeEach, mock, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { DrizzleQueryError } from "drizzle-orm/errors"
import { drizzle } from "drizzle-orm/d1"
import * as schema from "../app/lib/schema"
import { createTestDatabase } from "./helpers/database"
import { PERMISSIONS } from "../app/lib/permissions"
import { EMAIL_CONFIG } from "../app/config/email"

const { sqlite, d1 } = createTestDatabase()
const db = drizzle(d1, { schema })
let requestHeaders = new Headers()
let sessionId: string | undefined
let sessionRole = "duke"
const config = new Map<string, string>()
const configWrites: Array<[string, string]> = []

mock.module("../app/lib/db.ts", { namedExports: { createDb: () => db } })
mock.module("next/headers", { namedExports: { headers: async () => requestHeaders } })
mock.module("@opennextjs/cloudflare", { namedExports: { getCloudflareContext: () => ({ env: { DB: d1, SITE_CONFIG: { get: async (key: string) => config.get(key) ?? null, put: async (key: string, value: string) => { configWrites.push([key, value]); config.set(key, value) } } } }) } })
mock.module("../app/lib/auth.ts", { namedExports: { GET: async () => Response.json(sessionId ? { user: { id: sessionId } } : null), auth: async () => sessionId ? { user: { id: sessionId } } : null, getUserRole: async () => sessionRole, checkPermission: async (permission: string) => permission === "manage_api_key" ? Boolean(sessionId && !requestHeaders.has("X-API-Key") && sqlite.prepare("SELECT r.name FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE ur.user_id = ?").all(sessionId).some(role => role.name === "duke" || role.name === "emperor")) : sessionId === "owner", assignRoleToUser: async () => undefined, findOrCreateRole: async (_db: unknown, roleName: string) => ({ id: roleName }) } })

const { getUserId } = await import("../app/lib/apiKey")
const siteConfig = await import("../app/api/config/route")
const generate = await import("../app/api/emails/generate/route")
const mailboxes = await import("../app/api/emails/route")
const bulkMailboxes = await import("../app/api/emails/bulk/route")
const mailbox = await import("../app/api/emails/[id]/route")
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
const publicMailboxInfo = await import("../app/api/shared/[token]/route")
const publicMailboxMessages = await import("../app/api/shared/[token]/messages/route")
const emailService = await import("../app/api/config/email-service/route")
const send = await import("../app/api/emails/[id]/send/route")
const sendPermission = await import("../app/api/emails/send-permission/route")
const apiKeysRoute = await import("../app/api/api-keys/route")
const apiKeyRoute = await import("../app/api/api-keys/[id]/route")
const init = await import("../app/api/roles/init-emperor/route")

function reset() {
  config.clear()
  configWrites.length = 0
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
const bulkDeleteRequest = (ids: unknown) => new Request("https://app.example.com/api/emails/bulk", {
  method: "DELETE",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ids }),
})
const params = () => ({ params: Promise.resolve({ id: "email", messageId: "message" }) })
const sendParams = (id = "email") => ({ params: Promise.resolve({ id }) })
const sendRequest = (body: unknown = { to: "a@example.com", subject: "Subject", content: "<p>Hello</p>" }) =>
  new Request(request(), { method: "POST", body: JSON.stringify(body) })
const usedQuota = () => sqlite.prepare("SELECT COALESCE(SUM(used), 0) AS n FROM send_usage").get()?.n
const sentCount = () => sqlite.prepare("SELECT COUNT(*) AS n FROM message WHERE type = 'sent'").get()?.n

function createAsyncBarrier(participants: number) {
  let arrivals = 0
  let release!: () => void
  const released = new Promise<void>(resolve => { release = resolve })
  return async () => {
    arrivals += 1
    if (arrivals === participants) release()
    await released
  }
}

function pauseEmailInserts(t: TestContext, participants: number, beforeInsert?: () => void) {
  const waitForAllInserts = createAsyncBarrier(participants)
  let insertAttempts = 0
  const beforeExecution = async () => {
    insertAttempts += 1
    await waitForAllInserts()
    beforeInsert?.()
  }
  t.after(() => assert.equal(insertAttempts, participants, "Every intended insert must reach the barrier"))
  const originalPrepare = d1.prepare.bind(d1)
  t.mock.method(d1, "prepare", (query: string) => {
    const statement = originalPrepare(query)
    if (!/^insert into ["`]?email["`]?/i.test(query.trim())) return statement

    return new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: Parameters<typeof target.bind>) => {
            const bound = target.bind(...values)
            return new Proxy(bound, {
              get(boundTarget, boundProperty) {
                if (boundProperty === "first") {
                  return async (...args: Parameters<typeof boundTarget.first>) => {
                    await beforeExecution()
                    return boundTarget.first(...args)
                  }
                }
                if (boundProperty === "all") {
                  return async () => {
                    await beforeExecution()
                    return boundTarget.all()
                  }
                }
                if (boundProperty === "raw") {
                  return async (...args: Parameters<typeof boundTarget.raw>) => {
                    await beforeExecution()
                    return boundTarget.raw(...args)
                  }
                }
                const member = Reflect.get(boundTarget, boundProperty, boundTarget)
                return typeof member === "function" ? member.bind(boundTarget) : member
              },
            })
          }
        }
        const member = Reflect.get(target, property, target)
        return typeof member === "function" ? member.bind(target) : member
      },
    })
  })
}

function setWebhookEnvironment(t: TestContext, value: string) {
  const previous = process.env.WEBHOOK_ALLOWED_HOSTS
  process.env.WEBHOOK_ALLOWED_HOSTS = value
  t.after(() => {
    if (previous === undefined) delete process.env.WEBHOOK_ALLOWED_HOSTS
    else process.env.WEBHOOK_ALLOWED_HOSTS = previous
  })
}

test("pagination routes return HTTP 400 for malformed cursors without exposing data", async t => {
  const cursorValues = ["not-a-cursor", Buffer.from("null").toString("base64"),
    Buffer.from('{}').toString("base64"), Buffer.from('{"timestamp":"0","id":"message"}').toString("base64")]
  const routes = [
    ["mailboxes", (cursor: string) => mailboxes.GET(new Request(`https://app.example.com/api/emails?cursor=${encodeURIComponent(cursor)}`))],
    ["messages", (cursor: string) => mailbox.GET(new Request(`https://app.example.com/api/emails/email?cursor=${encodeURIComponent(cursor)}`), params())],
    ["shared messages", (cursor: string) => publicMailboxMessages.GET(new Request(`https://app.example.com/api/shared/mailbox-token/messages?cursor=${encodeURIComponent(cursor)}`), { params: Promise.resolve({ token: "mailbox-token" }) })],
    ["polling", (cursor: string) => mailbox.GET(new Request(`https://app.example.com/api/emails/email?since=${encodeURIComponent(cursor)}`), params())],
  ] as const
  for (const [name, getPage] of routes) {
    for (const cursor of cursorValues) {
      await t.test(`${name}: ${cursor}`, async () => {
        if (name === "shared messages") sqlite.exec("INSERT INTO email_share(id,email_id,token,created_at) VALUES('share','email','mailbox-token',0)")
        const response = await getPage(cursor)
        assert.equal(response.status, 400)
        assert.deepEqual(await response.json(), { error: "Invalid cursor" })
      })
    }
  }
})

test("cursor errors do not replace authentication, ownership, or expired-share responses", async () => {
  const invalid = "not-a-cursor"
  const listRequest = new Request(`https://app.example.com/api/emails?cursor=${invalid}`)
  const messagesRequest = new Request(`https://app.example.com/api/emails/email?cursor=${invalid}`)
  sessionId = undefined
  assert.equal((await mailboxes.GET(listRequest)).status, 401)
  assert.equal((await mailbox.GET(messagesRequest, params())).status, 401)
  sessionId = "owner"
  sqlite.exec("UPDATE email SET userId='victim'")
  assert.equal((await mailbox.GET(messagesRequest, params())).status, 403)
  const sharedRequest = new Request(`https://app.example.com/api/shared/mailbox-token/messages?cursor=${invalid}`)
  const sharedParams = { params: Promise.resolve({ token: "mailbox-token" }) }
  assert.equal((await publicMailboxMessages.GET(sharedRequest, sharedParams)).status, 404)
  sqlite.exec("INSERT INTO email_share(id,email_id,token,created_at,expires_at) VALUES('share','email','mailbox-token',0,0)")
  assert.equal((await publicMailboxMessages.GET(sharedRequest, sharedParams)).status, 410)
})

test("valid pagination cursors do not turn database failures into HTTP 400", async t => {
  sqlite.exec("INSERT INTO email_share(id,email_id,token,created_at) VALUES('share','email','mailbox-token',0)")
  const cursor = encodeURIComponent(Buffer.from('{"timestamp":100,"id":"message"}').toString("base64"))
  const fail = async () => { throw new Error("Synthetic query failure") }
  const mailboxQueries = t.mock.method(db.query.emails, "findMany", fail)
  const messageQueries = t.mock.method(db.query.messages, "findMany", fail)
  t.mock.method(console, "error", () => {})
  assert.equal((await mailboxes.GET(new Request(`https://app.example.com/api/emails?cursor=${cursor}`))).status, 500)
  assert.equal((await mailbox.GET(new Request(`https://app.example.com/api/emails/email?cursor=${cursor}`), params())).status, 500)
  assert.equal((await publicMailboxMessages.GET(new Request(`https://app.example.com/api/shared/mailbox-token/messages?cursor=${cursor}`), { params: Promise.resolve({ token: "mailbox-token" }) })).status, 500)
  assert.equal(mailboxQueries.mock.callCount(), 1)
  assert.equal(messageQueries.mock.callCount(), 2)
})

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

test("parallel mailbox creation cannot exceed the active mailbox cap", async t => {
  config.set("EMAIL_DOMAINS", "example.com")
  config.set("MAX_EMAILS", "2")
  const countBefore = Number(sqlite.prepare("SELECT COUNT(*) AS n FROM email WHERE userId = ?").get("owner")?.n)
  pauseEmailInserts(t, 2)

  const create = (name: string) => generate.POST(new Request(request(), {
    method: "POST",
    body: JSON.stringify({ name, domain: "example.com", expiryTime: 0 }),
  }))
  const responses = await Promise.all([create("race-one"), create("race-two")])

  assert.deepEqual(responses.map(response => response.status).sort((a, b) => a - b), [200, 403])
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) AS n FROM email WHERE userId = ?").get("owner")?.n) - countBefore, 1)

  const created = responses.find(response => response.status === 200)
  const refused = responses.find(response => response.status === 403)
  assert.ok(created)
  assert.ok(refused)
  assert.equal((await refused.json() as { error: string }).error, "已达到最大邮箱数量限制 (2)")
  const body = await created.json() as { id: string; email: string }
  assert.match(body.email, /^race-(one|two)@example\.com$/)
  assert.equal(sqlite.prepare("SELECT address FROM email WHERE id = ? AND userId = ?").get(body.id, "owner")?.address, body.email)
})

test("overlapping duplicate mailbox creation keeps one row and returns conflict", async t => {
  config.set("EMAIL_DOMAINS", "example.com")
  config.set("MAX_EMAILS", "2")
  const countBefore = Number(sqlite.prepare("SELECT COUNT(*) AS n FROM email WHERE userId = ?").get("owner")?.n)
  pauseEmailInserts(t, 2)

  const create = () => generate.POST(new Request(request(), {
    method: "POST",
    body: JSON.stringify({ name: "same-address", domain: "example.com", expiryTime: 0 }),
  }))
  const responses = await Promise.all([create(), create()])

  assert.deepEqual(responses.map(response => response.status).sort((a, b) => a - b), [200, 409])
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) AS n FROM email WHERE userId = ?").get("owner")?.n) - countBefore, 1)
  const conflict = responses.find(response => response.status === 409)
  assert.ok(conflict)
  assert.deepEqual(await conflict.json(), { error: "Email address already exists" })
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM email WHERE address = ?").get("same-address@example.com")?.n, 1)
})

test("overlapping mixed-case mailbox address conflicts remain HTTP 409", async t => {
  config.set("EMAIL_DOMAINS", "example.com")
  config.set("MAX_EMAILS", "10")
  const countBefore = Number(sqlite.prepare("SELECT COUNT(*) AS n FROM email").get()?.n)
  pauseEmailInserts(t, 1, () => {
    sqlite.prepare("INSERT INTO email(id,address,userId,created_at,expires_at) VALUES(?,?,?,?,?)")
      .run("mixed-case-winner", "MiXeD-Race@Example.com", "victim", Date.now(), Date.now() + 60_000)
  })

  const response = await generate.POST(new Request(request(), {
    method: "POST",
    body: JSON.stringify({ name: "mixed-race", domain: "example.com", expiryTime: 0 }),
  }))

  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: "Email address already exists" })
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) AS n FROM email").get()?.n), countBefore + 1)
  assert.equal(sqlite.prepare("SELECT address FROM email WHERE id = ?").get("mixed-case-winner")?.address, "MiXeD-Race@Example.com")
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) AS n FROM email WHERE address = ?").get("mixed-race@example.com")?.n), 0)
})

test("mailbox ID collisions preserve conflict responses", async t => {
  config.set("EMAIL_DOMAINS", "example.com")
  config.set("MAX_EMAILS", "10")
  const collisionId = "11111111-1111-4111-8111-111111111111"
  sqlite.prepare("INSERT INTO email(id,address,userId,created_at,expires_at) VALUES(?,?,?,?,?)")
    .run(collisionId, "existing-id@example.com", "victim", Date.now(), Date.now() + 60_000)
  t.mock.method(crypto, "randomUUID", () => collisionId)
  const countBefore = Number(sqlite.prepare("SELECT COUNT(*) AS n FROM email").get()?.n)

  const response = await generate.POST(new Request(request(), {
    method: "POST",
    body: JSON.stringify({ name: "new-address", domain: "example.com", expiryTime: 0 }),
  }))

  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: "Email address already exists" })
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) AS n FROM email").get()?.n), countBefore)
  assert.equal(sqlite.prepare("SELECT address FROM email WHERE id = ?").get(collisionId)?.address, "existing-id@example.com")
})

test("atomic mailbox creation does not count expired mailboxes toward the cap", async () => {
  config.set("EMAIL_DOMAINS", "example.com")
  config.set("MAX_EMAILS", "2")
  sqlite.prepare("INSERT INTO email(id,address,userId,created_at,expires_at) VALUES(?,?,?,?,?)")
    .run("expired-email", "expired@example.com", "owner", Date.now() - 120_000, Date.now() - 60_000)
  const activeBefore = Number(sqlite.prepare("SELECT COUNT(*) AS n FROM email WHERE userId = ? AND expires_at > ?").get("owner", Date.now())?.n)
  const countBefore = Number(sqlite.prepare("SELECT COUNT(*) AS n FROM email WHERE userId = ?").get("owner")?.n)
  assert.equal(activeBefore, 1)

  const response = await generate.POST(new Request(request(), {
    method: "POST",
    body: JSON.stringify({ name: "after-expired", domain: "example.com", expiryTime: 0 }),
  }))

  assert.equal(response.status, 200)
  const body = await response.json() as { id: string; email: string }
  assert.equal(body.email, "after-expired@example.com")
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) AS n FROM email WHERE userId = ?").get("owner")?.n) - countBefore, 1)
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) AS n FROM email WHERE userId = ? AND expires_at > ?").get("owner", Date.now())?.n), 2)
  assert.equal(sqlite.prepare("SELECT address FROM email WHERE id = ?").get(body.id)?.address, body.email)
})

test("mailbox limit settings reject invalid values before any config or mailbox writes", async () => {
  config.set("EMAIL_DOMAINS", "example.com")
  config.set("ADMIN_CONTACT", "previous@example.com")
  config.set("MAX_EMAILS", "7")
  const mailboxCountBefore = Number(sqlite.prepare("SELECT COUNT(*) AS n FROM email").get()?.n)

  const save = (maxEmails: string) => siteConfig.POST(new Request(request(), {
    method: "POST",
    body: JSON.stringify({
      defaultRole: "duke",
      emailDomains: "example.com",
      adminContact: "changed@example.com",
      maxEmails,
      catchAll: { domains: { "example.com": { enabled: true, showAlways: true, mailboxName: "reserved" } } },
    }),
  }))

  for (const maxEmails of ["abc", "-5", "0", "", "1.5", "9007199254740992", "1.0000000000000001", "9007199254740991.1"]) {
    assert.equal((await save(maxEmails)).status, 400, `maxEmails=${maxEmails} must be rejected`)
    assert.equal(config.get("MAX_EMAILS"), "7")
    assert.equal(config.get("EMAIL_DOMAINS"), "example.com")
    assert.equal(config.get("ADMIN_CONTACT"), "previous@example.com")
    assert.equal(Number(sqlite.prepare("SELECT COUNT(*) AS n FROM email").get()?.n), mailboxCountBefore)
    assert.equal(Number(sqlite.prepare("SELECT COUNT(*) AS n FROM catch_all_mailbox").get()?.n), 0)
    assert.equal(configWrites.length, 0)
  }
})

test("mailbox limits persist valid safe-integer boundaries and enforce them", async () => {
  const save = (maxEmails: string) => siteConfig.POST(new Request(request(), {
    method: "POST",
    body: JSON.stringify({ defaultRole: "duke", emailDomains: "example.com", adminContact: "", maxEmails }),
  }))

  const minimum = await save("1")
  assert.equal(minimum.status, 200)
  assert.equal(config.get("MAX_EMAILS"), "1")
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) AS n FROM email").get()?.n), 1)

  const denied = await generate.POST(new Request(request(), {
    method: "POST",
    body: JSON.stringify({ name: "over-limit", domain: "example.com", expiryTime: 0 }),
  }))
  assert.equal(denied.status, 403)
  assert.match((await denied.json() as { error: string }).error, /\(1\)$/)
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) AS n FROM email").get()?.n), 1)

  const maximum = String(Number.MAX_SAFE_INTEGER)
  const maximumSave = await save(maximum)
  assert.equal(maximumSave.status, 200)
  assert.equal(config.get("MAX_EMAILS"), maximum)
  assert.deepEqual(configWrites.filter(([key]) => key === "MAX_EMAILS").map(([, value]) => value), ["1", maximum])

  const created = await generate.POST(new Request(request(), {
    method: "POST",
    body: JSON.stringify({ name: "within-limit", domain: "example.com", expiryTime: 0 }),
  }))
  assert.equal(created.status, 200)
  const body = await created.json() as { id: string; email: string }
  assert.equal(body.email, "within-limit@example.com")
  assert.equal(sqlite.prepare("SELECT address FROM email WHERE id = ?").get(body.id)?.address, body.email)
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) AS n FROM email").get()?.n), 2)
})

test("invalid stored mailbox limits use the effective default instead of disabling the cap", async () => {
  config.set("EMAIL_DOMAINS", "example.com")
  config.set("MAX_EMAILS", "not-a-number")
  const settings = await siteConfig.GET()
  assert.equal(((await settings.json()) as { maxEmails: string }).maxEmails, String(EMAIL_CONFIG.MAX_ACTIVE_EMAILS))
  assert.equal(config.get("MAX_EMAILS"), "not-a-number")

  const expiresAt = Date.now() + 60_000
  const insertMailbox = sqlite.prepare("INSERT INTO email(id,address,userId,created_at,expires_at) VALUES(?,?,?, ?, ?)")
  for (let index = 1; index < EMAIL_CONFIG.MAX_ACTIVE_EMAILS; index += 1) {
    insertMailbox.run(`default-limit-${index}`, `default-limit-${index}@example.com`, "owner", Date.now(), expiresAt)
  }
  const mailboxCountBefore = Number(sqlite.prepare("SELECT COUNT(*) AS n FROM email").get()?.n)

  const response = await generate.POST(new Request(request(), {
    method: "POST",
    body: JSON.stringify({ name: "must-be-refused", domain: "example.com", expiryTime: 0 }),
  }))
  assert.equal(response.status, 403)
  assert.equal((await response.json() as { error: string }).error, `已达到最大邮箱数量限制 (${EMAIL_CONFIG.MAX_ACTIVE_EMAILS})`)
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) AS n FROM email").get()?.n), mailboxCountBefore)
  assert.equal(config.get("MAX_EMAILS"), "not-a-number")
})

test("website configuration never returns the stored Turnstile secret", async () => {
  config.set("EMAIL_DOMAINS", "example.com")
  config.set("TURNSTILE_ENABLED", "true")
  config.set("TURNSTILE_SITE_KEY", "public-site-key")
  config.set("TURNSTILE_SECRET_KEY", "private-turnstile-secret")

  const response = await siteConfig.GET()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("cache-control"), "no-store")
  const body = await response.text()
  assert.equal(body.includes("private-turnstile-secret"), false)

  const payload = JSON.parse(body) as { turnstile: { enabled: boolean; siteKey: string; hasSecret: boolean } }
  assert.equal(payload.turnstile.enabled, true)
  assert.equal(payload.turnstile.siteKey, "public-site-key")
  assert.equal(payload.turnstile.hasSecret, true)
  assert.equal(Object.hasOwn(payload.turnstile, "secretKey"), false)

  const carriesStoredSecret = (value: unknown): boolean => {
    if (typeof value === "string") return value.includes("private-turnstile-secret")
    if (Array.isArray(value)) return value.some(carriesStoredSecret)
    if (value && typeof value === "object") return Object.values(value).some(carriesStoredSecret)
    return false
  }
  assert.equal(carriesStoredSecret(payload), false)

  const save = (secretKey: string) => siteConfig.POST(new Request(request(), {
    method: "POST",
    body: JSON.stringify({
      defaultRole: "duke",
      emailDomains: "example.com",
      adminContact: "",
      maxEmails: "10",
      turnstile: { enabled: true, siteKey: "public-site-key", secretKey },
    }),
  }))

  // A blank secret keeps the stored value, so the operator never has to retype it.
  assert.equal((await save("")).status, 200)
  assert.equal(config.get("TURNSTILE_SECRET_KEY"), "private-turnstile-secret")
  assert.equal(config.get("TURNSTILE_ENABLED"), "true")
  assert.equal(config.get("TURNSTILE_SITE_KEY"), "public-site-key")

  // Enabling Turnstile still requires an effective secret.
  config.delete("TURNSTILE_SECRET_KEY")
  assert.equal((await save("")).status, 400)
  assert.equal(config.has("TURNSTILE_SECRET_KEY"), false)
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

  config.set("MAX_EMAILS", "1")
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

test("webhook configuration never returns the signing secret", async t => {
  await t.test("configured webhook", async t => {
    setWebhookEnvironment(t, "hooks.example.com")
    sqlite.exec("INSERT INTO webhook(id,user_id,url,secret,enabled,created_at,updated_at) VALUES('w','owner','https://hooks.example.com/event','super-secret-signing-key',1,0,0)")

    const response = await webhook.GET()
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("cache-control"), "no-store")
    const body = await response.text()
    assert.equal(body.includes("super-secret-signing-key"), false)
    assert.equal(body.includes('"secret"'), false)

    const payload = JSON.parse(body) as { enabled: boolean; url: string; hasSecret: boolean; setupError?: string }
    assert.equal(payload.enabled, true)
    assert.equal(payload.url, "https://hooks.example.com/event")
    assert.equal(payload.hasSecret, true)
  })

  await t.test("unconfigured webhook", async t => {
    setWebhookEnvironment(t, "")
    const payload = await (await webhook.GET()).json() as { enabled: boolean; url: string; hasSecret: boolean; setupError?: string }
    assert.equal(payload.enabled, false)
    assert.equal(payload.url, "")
    assert.equal(payload.hasSecret, false)
    assert.equal(payload.setupError, "setupRequired")
  })
})

test("admin user lists reject invalid pagination instead of failing with a server error", async () => {
  for (const query of ["page=abc", "page=0", "page=-1", "page=1e999", "pageSize=abc", "pageSize=0", "pageSize=51"]) {
    const response = await rolesUsers.GET(new Request(`https://app.example.com/api/roles/users?${query}`))
    assert.equal(response.status, 400, query)
  }
  const valid = await rolesUsers.GET(new Request("https://app.example.com/api/roles/users?page=1&pageSize=20"))
  assert.equal(valid.status, 200)
})

test("malformed request bodies return HTTP 400 instead of a server error", async t => {
  const promote = await import("../app/api/roles/promote/route")
  const malformed = ["", "{", "null", "[]"]
  for (const body of malformed) {
    await t.test(`promote body ${body || "empty"}`, async () => {
      const response = await promote.POST(new Request(request(), { method: "POST", body }))
      assert.equal(response.status, 400)
    })
    await t.test(`user search body ${body || "empty"}`, async () => {
      const response = await rolesUsers.POST(new Request(request(), { method: "POST", body }))
      assert.equal(response.status, 400)
    })
    await t.test(`generate body ${body || "empty"}`, async () => {
      config.set("EMAIL_DOMAINS", "example.com")
      const response = await generate.POST(new Request(request(), { method: "POST", body }))
      assert.equal(response.status, 400)
    })
  }
})

test("forged identity headers never replace a verified session or create one", async () => {
  requestHeaders.set("X-User-Id", "victim")
  assert.equal(await getUserId(), "owner")
  sessionId = undefined
  assert.equal(await getUserId(), undefined)
})

test("API key creation rejects malformed bodies without storing credentials", async t => {
  for (const body of ['{', '', 'null', '[]', '0', '"name"', '{}',
    '{"name":null}', '{"name":42}', '{"name":true}', '{"name":[]}', '{"name":{}}',
    '{"name":""}', '{"name":"   "}']) {
    await t.test(body || "empty body", async () => {
      const response = await apiKeysRoute.POST(new Request("https://app.example.com/api/api-keys", {
        method: "POST", body,
      }))
      assert.equal(response.status, 400)
      assert.equal(typeof (await response.json() as { error: string }).error, "string")
      assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM api_keys").get()?.n, 0)
    })
  }
})

test("duplicate API key names return HTTP 409 without replacing or revealing existing credentials", async t => {
  const create = (name: string) => apiKeysRoute.POST(new Request("https://app.example.com/api/api-keys", {
    method: "POST", body: JSON.stringify({ name }),
  }))
  const initial = await create("Automation")
  assert.equal(initial.status, 200)
  const { key } = await initial.json() as { key: string }
  sqlite.exec("UPDATE api_keys SET enabled = 0, expires_at = 0")
  const before = sqlite.prepare("SELECT * FROM api_keys").all()
  const logs = t.mock.method(console, "error", () => {})
  const duplicate = await create("Automation")
  assert.equal(duplicate.status, 409)
  const body = await duplicate.json() as { code: string; error: string; key?: string }
  assert.equal(body.code, "API_KEY_NAME_EXISTS")
  assert.equal(typeof body.error, "string")
  assert.equal(body.key, undefined)
  assert.equal(JSON.stringify(body).includes(key), false)
  assert.deepEqual(sqlite.prepare("SELECT * FROM api_keys").all(), before)
  assert.equal(logs.mock.callCount(), 0)
})

test("API key name conflicts remain scoped to the owner", async () => {
  sqlite.exec("INSERT INTO api_keys(id,user_id,name,key,enabled) VALUES('foreign','victim','Automation','other-test-key',1)")
  const response = await apiKeysRoute.POST(new Request("https://app.example.com/api/api-keys", {
    method: "POST", body: JSON.stringify({ name: "Automation" }),
  }))
  assert.equal(response.status, 200)
  const { key } = await response.json() as { key: string }
  assert.equal(sqlite.prepare("SELECT user_id FROM api_keys WHERE key = ?").get(key)?.user_id, "owner")
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE name = 'Automation'").get()?.n, 2)
})

test("API key updates reject non-booleans without changing stored state or access", async t => {
  for (const initial of [false, true]) {
    for (const body of ['{', '', 'null', '[]', '0', '"false"', '{}',
      '{"enabled":null}', '{"enabled":"false"}', '{"enabled":"true"}',
      '{"enabled":0}', '{"enabled":1}', '{"enabled":[]}', '{"enabled":{}}']) {
      await t.test(`${initial}: ${body || "empty body"}`, async () => {
        reset()
        sqlite.prepare("INSERT INTO api_keys(id,user_id,name,key,enabled,expires_at) VALUES('key','owner','test','test-key',?,?)")
          .run(Number(initial), Math.floor(Date.now() / 1000) + 3600)
        const response = await apiKeyRoute.PATCH(new Request("https://app.example.com/api/api-keys/key", {
          method: "PATCH", body,
        }), { params: Promise.resolve({ id: "key" }) })
        assert.equal(sqlite.prepare("SELECT enabled FROM api_keys WHERE id = 'key'").get()?.enabled, Number(initial))
        assert.equal(response.status, 400)
        requestHeaders.set("X-API-Key", "test-key")
        assert.equal(await getUserId(PERMISSIONS.MANAGE_EMAIL), initial ? "owner" : undefined)
      })
    }
  }
})

test("API key mutations preserve valid names, boolean toggles, and owner isolation", async t => {
  const now = 1_800_000_000_000
  t.mock.timers.enable({ apis: ["Date"], now })
  const name = " Personal automation "
  const created = await apiKeysRoute.POST(new Request("https://app.example.com/api/api-keys", {
    method: "POST", body: JSON.stringify({ name }),
  }))
  assert.equal(created.status, 200)
  assert.equal(created.headers.get("Cache-Control"), "no-store")
  const { key } = await created.json() as { key: string }
  const stored = sqlite.prepare("SELECT id, user_id, name, enabled, expires_at FROM api_keys WHERE key = ?").get(key)
  assert.ok(stored)
  assert.equal(stored.name, name)
  assert.equal(stored.user_id, "owner")
  assert.equal(stored.enabled, 1)
  assert.equal(stored.expires_at, (now + 365 * 24 * 60 * 60 * 1000) / 1000)
  const listed = await (await apiKeysRoute.GET()).json() as { apiKeys: Record<string, unknown>[] }
  assert.equal(listed.apiKeys.length, 1)
  assert.equal(listed.apiKeys[0].key, key)

  const update = (id: string, enabled: boolean) => apiKeyRoute.PATCH(new Request("https://app.example.com/api/api-keys/key", {
    method: "PATCH", body: JSON.stringify({ enabled }),
  }), { params: Promise.resolve({ id }) })
  requestHeaders.set("X-API-Key", key)
  assert.equal(await getUserId(PERMISSIONS.MANAGE_EMAIL), "owner")
  requestHeaders.delete("X-API-Key")
  for (const enabled of [false, true]) {
    assert.equal((await update(String(stored.id), enabled)).status, 200)
    assert.equal(sqlite.prepare("SELECT enabled FROM api_keys WHERE key = ?").get(key)?.enabled, Number(enabled))
    requestHeaders.set("X-API-Key", key)
    assert.equal(await getUserId(PERMISSIONS.MANAGE_EMAIL), enabled ? "owner" : undefined)
    requestHeaders.delete("X-API-Key")
  }
  sqlite.exec("INSERT INTO api_keys(id,user_id,name,key,enabled) VALUES('foreign','victim','other','other-key',0)")
  assert.equal((await update("foreign", true)).status, 404)
  assert.equal((await update("missing", true)).status, 404)
  assert.equal(sqlite.prepare("SELECT enabled FROM api_keys WHERE id = 'foreign'").get()?.enabled, 0)
  sessionId = undefined
  assert.equal((await update(String(stored.id), false)).status, 403)
  assert.equal(sqlite.prepare("SELECT enabled FROM api_keys WHERE key = ?").get(key)?.enabled, 1)
})

test("API key lists reveal stored keys only to the managing session owner and disable caching", async () => {
  const expiresAt = Math.floor(Date.now() / 1000) + 3600
  sqlite.prepare("INSERT INTO api_keys(id,user_id,name,key,created_at,expires_at) VALUES('owner-key','owner','Owner key','mk_owner_secret',100,?),('victim-key','victim','Victim key','mk_victim_secret',100,?)")
    .run(expiresAt, expiresAt)
  sqlite.exec("INSERT INTO user_role(user_id,role_id) VALUES('victim','duke')")
  const request = new Request("https://app.example.com/api/api-keys")

  const ownerResponse = await apiKeysRoute.GET(request)
  assert.equal(ownerResponse.status, 200)
  assert.equal(ownerResponse.headers.get("Cache-Control"), "no-store")
  const ownerBody = await ownerResponse.json() as { apiKeys: Array<{ id: string; key: string }> }
  assert.deepEqual(ownerBody.apiKeys.map(({ id, key }) => ({ id, key })), [
    { id: "owner-key", key: "mk_owner_secret" },
  ])

  requestHeaders.set("X-API-Key", "mk_owner_secret")
  const apiKeyResponse = await apiKeysRoute.GET(request)
  assert.equal(apiKeyResponse.status, 403)
  assert.equal(apiKeyResponse.headers.get("Cache-Control"), "no-store")
  assert.equal(await getUserId(PERMISSIONS.MANAGE_API_KEY), undefined)
  requestHeaders.delete("X-API-Key")

  sessionId = "victim"
  const victimResponse = await apiKeysRoute.GET(request)
  assert.equal(victimResponse.status, 200)
  assert.equal(victimResponse.headers.get("Cache-Control"), "no-store")
  const victimBody = await victimResponse.json() as { apiKeys: Array<{ id: string; key: string }> }
  assert.deepEqual(victimBody.apiKeys.map(({ id, key }) => ({ id, key })), [
    { id: "victim-key", key: "mk_victim_secret" },
  ])

  sqlite.exec("UPDATE user_role SET role_id = 'knight' WHERE user_id = 'victim'")
  assert.equal(await getUserId(PERMISSIONS.MANAGE_API_KEY), undefined)
  const unauthorizedResponse = await apiKeysRoute.GET(request)
  assert.equal(unauthorizedResponse.status, 403)
  assert.equal(unauthorizedResponse.headers.get("Cache-Control"), "no-store")
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

test("mailbox deletion preserves all records on failure and cascades with one delete on success", async t => {
  for (const failure of [false, true]) {
    await t.test(failure ? "mailbox delete fails" : "successful cascade", async t => {
      reset()
      sqlite.prepare("INSERT INTO email(id,address,userId,created_at,expires_at) VALUES('other','victim@example.com','victim',0,?)").run(Date.now() + 60_000)
      sqlite.exec("INSERT INTO message(id,emailId,subject,content,received_at,sent_at,type) VALUES('other-message','other','Other','other body',100,200,'received')")
      sqlite.exec("INSERT INTO email_share(id,email_id,token,created_at) VALUES('share','email','mailbox-token',0),('other-share','other','other-mailbox-token',0)")
      sqlite.exec("INSERT INTO message_share(id,message_id,token,created_at) VALUES('message-share','message','message-token',0),('other-message-share','other-message','other-message-token',0)")
      const tables = ["email", "message", "email_share", "message_share", "message_arrival"]
      const snapshot = () => Object.fromEntries(tables.map(table => [table, sqlite.prepare(`SELECT * FROM "${table}" ORDER BY 1`).all()]))
      const before = snapshot()
      const deletes: string[] = []
      const originalPrepare = d1.prepare.bind(d1)
      t.mock.method(d1, "prepare", (sql: string) => {
        if (sql.toLowerCase().startsWith("delete from")) deletes.push(sql)
        if (failure && sql.toLowerCase().startsWith('delete from "email"')) throw new Error("Synthetic mailbox delete failure")
        return originalPrepare(sql)
      })
      if (failure) t.mock.method(console, "error", () => {})
      const response = await mailbox.DELETE(request(), sendParams())
      assert.equal(response.status, failure ? 500 : 200)
      if (failure) {
        assert.deepEqual(snapshot(), before)
      } else {
        assert.deepEqual(await response.json(), { success: true })
        assert.equal(deletes.length, 1)
        assert.match(deletes[0], /^delete from "email"/i)
        assert.deepEqual(sqlite.prepare("SELECT id FROM email").all().map(row => row.id), ["other"])
        assert.deepEqual(sqlite.prepare("SELECT id FROM message").all().map(row => row.id), ["other-message"])
        assert.deepEqual(sqlite.prepare("SELECT id FROM email_share").all().map(row => row.id), ["other-share"])
        assert.deepEqual(sqlite.prepare("SELECT id FROM message_share").all().map(row => row.id), ["other-message-share"])
        assert.deepEqual(sqlite.prepare("SELECT message_id FROM message_arrival").all().map(row => row.message_id), ["other-message"])
      }
    })
  }
})

test("bulk mailbox deletion requires permission and rejects invalid or oversized requests", async () => {
  sessionId = undefined
  assert.equal((await bulkMailboxes.DELETE(bulkDeleteRequest(["email"]))).status, 401)
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM email").get()?.n, 1)

  sessionId = "victim"
  assert.equal((await bulkMailboxes.DELETE(bulkDeleteRequest(["email"]))).status, 401)
  sessionId = "owner"

  const invalidBodies = [
    "not-json",
    JSON.stringify({ ids: [] }),
    JSON.stringify({ ids: ["email", "email"] }),
    JSON.stringify({ ids: [""] }),
    JSON.stringify({ ids: Array.from({ length: 41 }, (_, index) => `email-${index}`) }),
    JSON.stringify({ ids: ["email"], ignored: "x".repeat(9 * 1024) }),
  ]
  for (const body of invalidBodies) {
    const response = await bulkMailboxes.DELETE(new Request("https://app.example.com/api/emails/bulk", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body,
    }))
    assert.equal(response.status, 400)
  }
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM email").get()?.n, 1)
})

test("bulk mailbox deletion keeps the maximum D1 bind count below 100", async t => {
  const ids = ["email"]
  const insert = sqlite.prepare("INSERT INTO email(id,address,userId,created_at,expires_at) VALUES(?,?, 'owner',0,?)")
  for (let index = 1; index < 40; index += 1) {
    const id = `bulk-${index}`
    ids.push(id)
    insert.run(id, `${id}@example.com`, Date.now() + 60_000)
  }

  const bindCounts: number[] = []
  const originalPrepare = d1.prepare.bind(d1)
  t.mock.method(d1, "prepare", (statement: string) => {
    const prepared = originalPrepare(statement)
    return new Proxy(prepared, {
      get(target, property) {
        if (property === "bind") {
          return (...values: Parameters<typeof target.bind>) => {
            bindCounts.push(values.length)
            return target.bind(...values)
          }
        }
        const member = Reflect.get(target, property, target)
        return typeof member === "function" ? member.bind(target) : member
      },
    })
  })

  const response = await bulkMailboxes.DELETE(bulkDeleteRequest(ids))
  assert.equal(response.status, 200)
  assert.equal(Math.max(...bindCounts), 85)
  assert.ok(Math.max(...bindCounts) <= 100)
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM email").get()?.n, 0)
})

test("bulk mailbox deletion refuses mixed ownership, expired accounts and Catch-all mailboxes without partial deletion", async () => {
  const tables = ["email", "message", "email_share", "message_share", "message_arrival"]
  const snapshot = () => Object.fromEntries(tables.map(table => [table, sqlite.prepare(`SELECT * FROM "${table}" ORDER BY 1`).all()]))

  sqlite.prepare("INSERT INTO email(id,address,userId,created_at,expires_at) VALUES('active','active@example.com','owner',0,?)").run(Date.now() + 60_000)
  sqlite.prepare("INSERT INTO email(id,address,userId,created_at,expires_at) VALUES('foreign','victim@example.com','victim',0,?)").run(Date.now() + 60_000)
  sqlite.exec("INSERT INTO message(id,emailId,subject,content,received_at,sent_at,type) VALUES('foreign-message','foreign','Other','other body',100,200,'received')")
  sqlite.exec("INSERT INTO email_share(id,email_id,token,created_at) VALUES('owner-share','email','owner-token',0),('foreign-share','foreign','foreign-token',0)")
  sqlite.exec("INSERT INTO message_share(id,message_id,token,created_at) VALUES('owner-message-share','message','owner-message-token',0),('foreign-message-share','foreign-message','foreign-message-token',0)")
  const beforeMixedOwnership = snapshot()
  const mixedOwnership = await bulkMailboxes.DELETE(bulkDeleteRequest(["email", "foreign"]))
  assert.equal(mixedOwnership.status, 403)
  assert.deepEqual(snapshot(), beforeMixedOwnership)

  sqlite.exec("UPDATE email SET expires_at = 0 WHERE id = 'email'")
  const beforeExpired = snapshot()
  const expired = await bulkMailboxes.DELETE(bulkDeleteRequest(["email", "active"]))
  assert.equal(expired.status, 403)
  assert.deepEqual(snapshot(), beforeExpired)
  sqlite.prepare("UPDATE email SET expires_at = ? WHERE id = 'email'").run(Date.now() + 60_000)

  sqlite.exec("INSERT INTO catch_all_mailbox(domain,email_id) VALUES('example.com','email')")
  const beforeRegisteredCatchAll = snapshot()
  const registeredCatchAll = await bulkMailboxes.DELETE(bulkDeleteRequest(["email"]))
  assert.equal(registeredCatchAll.status, 403)
  assert.deepEqual(snapshot(), beforeRegisteredCatchAll)

  sqlite.exec("DELETE FROM catch_all_mailbox")
  config.set("CATCHALL_EMAIL", JSON.stringify({ "example.com": { address: "owner@example.com", enabled: true } }))
  const beforeLegacyCatchAll = snapshot()
  const legacyCatchAll = await bulkMailboxes.DELETE(bulkDeleteRequest(["email"]))
  assert.equal(legacyCatchAll.status, 403)
  assert.deepEqual(snapshot(), beforeLegacyCatchAll)
})

test("bulk mailbox deletion rechecks ownership in its atomic delete and cascades once for all selected accounts", async t => {
  const seed = () => {
    reset()
    sqlite.prepare("INSERT INTO email(id,address,userId,created_at,expires_at) VALUES('second','second@example.com','owner',0,?)").run(Date.now() + 60_000)
    sqlite.prepare("INSERT INTO email(id,address,userId,created_at,expires_at) VALUES('foreign','victim@example.com','victim',0,?)").run(Date.now() + 60_000)
    sqlite.exec("INSERT INTO message(id,emailId,subject,content,received_at,sent_at,type) VALUES('second-message','second','Second','second body',100,200,'received'),('foreign-message','foreign','Other','other body',100,200,'received')")
    sqlite.exec("INSERT INTO email_share(id,email_id,token,created_at) VALUES('share','email','mailbox-token',0),('second-share','second','second-mailbox-token',0),('foreign-share','foreign','foreign-mailbox-token',0)")
    sqlite.exec("INSERT INTO message_share(id,message_id,token,created_at) VALUES('message-share','message','message-token',0),('second-message-share','second-message','second-message-token',0),('foreign-message-share','foreign-message','foreign-message-token',0)")
  }
  const tables = ["email", "message", "email_share", "message_share", "message_arrival"]
  const snapshot = () => Object.fromEntries(tables.map(table => [table, sqlite.prepare(`SELECT * FROM "${table}" ORDER BY 1`).all()]))

  seed()
  const beforeRace = snapshot()
  const originalPrepare = d1.prepare.bind(d1)
  let changedOwner = false
  const racePrepare = t.mock.method(d1, "prepare", (statement: string) => {
    if (!changedOwner && /^delete from ["`]?email["`]?/i.test(statement.trim())) {
      changedOwner = true
      sqlite.exec("UPDATE email SET userId = 'victim' WHERE id = 'email'")
    }
    return originalPrepare(statement)
  })
  const raced = await bulkMailboxes.DELETE(bulkDeleteRequest(["email", "second"]))
  assert.equal(changedOwner, true)
  assert.equal(raced.status, 403)
  const afterRace = snapshot()
  assert.deepEqual(afterRace.email.map(({ id, address }) => ({ id, address })), beforeRace.email.map(({ id, address }) => ({ id, address })))
  for (const table of tables.slice(1)) assert.deepEqual(afterRace[table], beforeRace[table])
  assert.equal(sqlite.prepare("SELECT userId FROM email WHERE id = 'email'").get()?.userId, "victim")
  // The simulated owner change happened immediately before DELETE prepared.
  // The atomic eligibility guard must leave every selected resource in place.
  racePrepare.mock.restore()
  seed()
  const beforeFailure = snapshot()
  const deletes: string[] = []
  const failurePrepare = t.mock.method(d1, "prepare", (statement: string) => {
    if (/^delete from /i.test(statement.trim())) deletes.push(statement)
    if (/^delete from ["`]?email["`]?/i.test(statement.trim())) throw new Error("Synthetic bulk mailbox delete failure")
    return originalPrepare(statement)
  })
  t.mock.method(console, "error", () => {})
  const failed = await bulkMailboxes.DELETE(bulkDeleteRequest(["email", "second"]))
  assert.equal(failed.status, 500)
  assert.deepEqual(snapshot(), beforeFailure)
  assert.equal(deletes.length, 1)

  failurePrepare.mock.restore()
  seed()
  const successfulDeletes: string[] = []
  t.mock.method(d1, "prepare", (statement: string) => {
    if (/^delete from /i.test(statement.trim())) successfulDeletes.push(statement)
    return originalPrepare(statement)
  })
  const succeeded = await bulkMailboxes.DELETE(bulkDeleteRequest(["email", "second"]))
  assert.equal(succeeded.status, 200)
  const result = await succeeded.json() as { success: boolean; deletedIds: string[] }
  assert.equal(result.success, true)
  assert.deepEqual(new Set(result.deletedIds), new Set(["email", "second"]))
  assert.equal(successfulDeletes.length, 1)
  assert.deepEqual(sqlite.prepare("SELECT id FROM email ORDER BY id").all().map(row => row.id), ["foreign"])
  assert.deepEqual(sqlite.prepare("SELECT id FROM message ORDER BY id").all().map(row => row.id), ["foreign-message"])
  assert.deepEqual(sqlite.prepare("SELECT id FROM email_share ORDER BY id").all().map(row => row.id), ["foreign-share"])
  assert.deepEqual(sqlite.prepare("SELECT id FROM message_share ORDER BY id").all().map(row => row.id), ["foreign-message-share"])
  assert.deepEqual(sqlite.prepare("SELECT message_id FROM message_arrival").all().map(row => row.message_id), ["foreign-message"])
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

test("share creation rejects invalid expiry requests without persisting links", async t => {
  for (const [name, route] of [["mailbox", shares], ["message", messageShares]] as const) {
    await t.test(name, async t => {
      for (const body of [
        '{', '', 'null', '[]', '0', '"invalid"',
        '{"expiresIn":-1}', '{"expiresIn":-0.5}', '{"expiresIn":0.5}',
        '{"expiresIn":"86400000"}', '{"expiresIn":"0"}',
        '{"expiresIn":null}', '{"expiresIn":false}', '{"expiresIn":true}',
        '{"expiresIn":[]}', '{"expiresIn":{}}',
        '{"expiresIn":1e309}', '{"expiresIn":9007199254740992}',
        '{"expiresIn":8640000000000000}',
      ]) {
        await t.test(body || "empty body", async () => {
          const response = await route.POST(new Request(request(), { method: "POST", body }), params())
          assert.equal(response.status, 400)
          assert.equal(typeof (await response.json() as { error: string }).error, "string")
          assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM email_share").get()?.n, 0)
          assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM message_share").get()?.n, 0)
        })
      }
    })
  }
})

test("share creation preserves permanent defaults and exact valid expiry timestamps", async t => {
  const now = 1_800_000_000_000
  t.mock.timers.enable({ apis: ["Date"], now })
  for (const [name, route, table] of [["mailbox", shares, "email_share"], ["message", messageShares, "message_share"]] as const) {
    await t.test(name, async t => {
      for (const expiresIn of [undefined, 0, 1, 86_400_000, 8_640_000_000_000_000 - now]) {
        await t.test(String(expiresIn), async () => {
          reset()
          const response = await route.POST(new Request(request(), {
            method: "POST", body: JSON.stringify({ expiresIn }),
          }), params())
          assert.equal(response.status, 201)
          const body = await response.json() as { id: string; token: string; expiresAt: string | null }
          const expected = expiresIn ? now + expiresIn : null
          assert.equal(body.expiresAt, expected === null ? null : new Date(expected).toISOString())
          const stored = sqlite.prepare(`SELECT token, expires_at FROM ${table} WHERE id = ?`).get(body.id)
          assert.equal(stored?.token, body.token)
          assert.equal(stored?.expires_at, expected)
        })
      }
    })
  }
})

test("share creation preserves authentication and ownership checks", async t => {
  for (const [name, route, deniedStatus] of [["mailbox", shares, 404], ["message", messageShares, 403]] as const) {
    await t.test(name, async () => {
      reset()
      sessionId = undefined
      assert.equal((await route.POST(new Request(request(), { method: "POST", body: '{}' }), params())).status, 401)
      sessionId = "owner"
      sqlite.exec("UPDATE email SET userId = 'victim'")
      assert.equal((await route.POST(new Request(request(), { method: "POST", body: '{}' }), params())).status, deniedStatus)
      assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM email_share").get()?.n, 0)
      assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM message_share").get()?.n, 0)
    })
  }
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

test("public mailbox endpoints reject shares and mailboxes at the exact expiry boundary", async t => {
  const now = 1_800_000_000_000
  t.mock.timers.enable({ apis: ["Date"], now })
  for (const [endpoint, route] of [["metadata", publicMailboxInfo], ["messages", publicMailboxMessages], ["detail", publicMailboxMessage]] as const) {
    for (const scenario of ["active", "share expires now", "share expired", "mailbox expires now", "mailbox expired"]) {
      await t.test(`${endpoint}: ${scenario}`, async () => {
        reset()
        sessionId = undefined
        sqlite.prepare("INSERT INTO email_share(id,email_id,token,created_at,expires_at) VALUES('share','email','mailbox-token',0,?)").run(now + 1)
        if (scenario.startsWith("share")) sqlite.prepare("UPDATE email_share SET expires_at = ?").run(now - Number(scenario === "share expired"))
        if (scenario.startsWith("mailbox")) sqlite.prepare("UPDATE email SET expires_at = ?").run(now - Number(scenario === "mailbox expired"))
        const response = await route.GET(request(), { params: Promise.resolve({ token: "mailbox-token", messageId: "message" }) })
        assert.equal(response.status, scenario === "active" ? 200 : 410)
        const body = await response.json() as Record<string, unknown>
        if (scenario !== "active") {
          assert.equal(typeof body.error, "string")
          for (const field of ["email", "messages", "message"]) assert.equal(Object.hasOwn(body, field), false)
          assert.equal(JSON.stringify(body).includes("secret"), false)
        }
      })
    }
  }
})

test("public mailbox lists query only message summaries and preserve pagination", async t => {
  sqlite.exec("INSERT INTO email_share(id,email_id,token,created_at) VALUES('share','email','mailbox-token',0)")
  sqlite.prepare("UPDATE message SET content = ?, html = ?").run("large private body ".repeat(10_000), "<p>large private HTML</p>".repeat(10_000))
  const insert = sqlite.prepare("INSERT INTO message(id,emailId,subject,content,received_at,sent_at,type) VALUES(?,'email',?,'body',100,200,'received')")
  for (let index = 0; index < 20; index++) insert.run(`message-${String(index).padStart(2, "0")}`, `Subject ${index}`)
  sqlite.exec("INSERT INTO message(id,emailId,subject,content,received_at,sent_at,type) VALUES('sent','email','Private sent','body',300,300,'sent')")
  const queries: string[] = []
  const originalPrepare = d1.prepare.bind(d1)
  t.mock.method(d1, "prepare", (sql: string) => {
    if (sql.toLowerCase().includes('from "message"')) queries.push(sql)
    return originalPrepare(sql)
  })
  const getPage = (cursor = "") => publicMailboxMessages.GET(new Request(`https://app.example.com/api/shared/mailbox-token/messages?cursor=${encodeURIComponent(cursor)}`), {
    params: Promise.resolve({ token: "mailbox-token" }),
  })
  const response = await getPage()
  assert.equal(response.status, 200)
  const first = await response.json() as { messages: Record<string, unknown>[]; total: number; nextCursor: string }
  assert.equal(first.total, 21)
  assert.equal(first.messages.length, 20)
  assert.equal(first.messages[0].id, "message-19")
  assert.ok(first.nextCursor)
  const next = await getPage(first.nextCursor)
  assert.equal(next.status, 200)
  const second = await next.json() as { messages: Record<string, unknown>[]; total: number; nextCursor: null }
  assert.equal(second.total, 21)
  assert.equal(second.nextCursor, null)
  assert.deepEqual(second.messages.map(message => message.id), ["message"])
  const combined = [...first.messages, ...second.messages]
  assert.equal(new Set(combined.map(message => message.id)).size, 21)
  for (const message of combined) {
    assert.equal(Object.hasOwn(message, "content"), false)
    assert.equal(Object.hasOwn(message, "html"), false)
  }
  assert.ok(queries.length >= 2)
  for (const sql of queries) assert.doesNotMatch(sql, /"(?:content|html)"/)
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

test("API key clients can create, list, send, read, and delete mailboxes without a session", async t => {
  sessionId = undefined
  config.set("EMAIL_DOMAINS", "example.com")
  sqlite.prepare("INSERT INTO api_keys(id,user_id,name,key,enabled,expires_at) VALUES('key','owner','test','test-key',1,?)")
    .run(Math.floor(Date.now() / 1000) + 3600)
  requestHeaders.set("X-API-Key", "test-key")
  const provider = t.mock.method(globalThis, "fetch", async () => Response.json({ id: "sent" }))

  const settings = await (await siteConfig.GET()).json() as { availableEmailDomains: string[] }
  assert.deepEqual(settings.availableEmailDomains, ["example.com"])
  const created = await generate.POST(new Request(request(), {
    method: "POST", body: JSON.stringify({ name: "api-client", domain: "example.com", expiryTime: 0 }),
  }))
  assert.equal(created.status, 200)
  const { id, email } = await created.json() as { id: string; email: string }
  assert.equal(email, "api-client@example.com")
  const listed = await mailboxes.GET(new Request("https://app.example.com/api/emails"))
  assert.equal(listed.status, 200)
  assert.ok((await listed.json() as { emails: { id: string }[] }).emails.some(row => row.id === id))

  assert.equal((await send.POST(sendRequest(), sendParams(id))).status, 200)
  assert.equal(provider.mock.callCount(), 1)
  const sent = await mailbox.GET(new Request(`https://app.example.com/api/emails/${id}?type=sent`), sendParams(id))
  assert.equal(sent.status, 200)
  const messages = (await sent.json() as { messages: { id: string }[] }).messages
  assert.equal(messages.length, 1)
  const message = await detail.GET(request(), { params: Promise.resolve({ id, messageId: messages[0].id }) })
  assert.equal(message.status, 200)
  assert.equal((await message.json() as { message: { html: string } }).message.html, "<p>Hello</p>")

  assert.equal((await mailbox.DELETE(request(), sendParams(id))).status, 200)
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM email WHERE id=?").get(id)?.n, 0)
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM message WHERE emailId=?").get(id)?.n, 0)
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM email WHERE id='email'").get()?.n, 1)
  assert.equal(usedQuota(), 1)
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

test("Catch-all sending uses the registered identity through session and API key authentication", async t => {
  for (const authentication of ["session", "API key"]) {
    for (const scenario of ["stale address", "stale address with override", "missing config", "legacy address"]) {
      await t.test(`${authentication}: ${scenario}`, async t => {
        reset()
        config.set("EMAIL_DOMAINS", "example.com")
        sqlite.exec("UPDATE email SET address='renamed@example.com'; UPDATE user_role SET role_id='emperor' WHERE user_id='owner'")
        sessionRole = "emperor"
        if (scenario !== "legacy address") {
          sqlite.exec("INSERT INTO catch_all_mailbox(domain,email_id) VALUES('example.com','email')")
        }
        if (scenario !== "missing config") {
          config.set("CATCHALL_EMAIL", JSON.stringify({
            "example.com": { address: scenario === "legacy address" ? "renamed@example.com" : "old@example.com", enabled: true, showAlways: true },
          }))
        }
        if (authentication === "API key") {
          sessionId = undefined
          sqlite.prepare("INSERT INTO api_keys(id,user_id,name,key,enabled,expires_at) VALUES('key','owner','test','test-key',1,?)")
            .run(Math.floor(Date.now() / 1000) + 3600)
          requestHeaders.set("X-API-Key", "test-key")
        }
        const provider = t.mock.method(globalThis, "fetch", async () => Response.json({ id: "sent" }))
        const fromLocalPart = scenario === "stale address" ? "renamed" : "Reply.Team"
        const response = await send.POST(sendRequest({
          to: "a@example.com", subject: "Subject", content: "Hello", fromLocalPart,
        }), sendParams())

        assert.equal(response.status, 200)
        assert.equal(provider.mock.callCount(), 1)
        const from = `${fromLocalPart.toLowerCase()}@example.com`
        assert.equal(JSON.parse(provider.mock.calls[0].arguments[1]?.body as string).from, from)
        assert.deepEqual({ ...sqlite.prepare("SELECT emailId,from_address FROM message WHERE type='sent'").get() }, {
          emailId: "email", from_address: from,
        })
        assert.equal(usedQuota(), 1)
      })
    }
  }
})

test("a Catch-all registration never grants sender overrides to other mailboxes or non-emperors", async t => {
  for (const scenario of ["old address reused", "non-emperor"]) {
    await t.test(scenario, async () => {
      reset()
      config.set("EMAIL_DOMAINS", "example.com")
      config.set("CATCHALL_EMAIL", JSON.stringify({
        "example.com": { address: "owner@example.com", enabled: true, showAlways: true },
      }))
      sqlite.prepare("INSERT INTO email(id,address,userId,created_at,expires_at) VALUES('catch','renamed@example.com','owner',0,?)")
        .run(Date.now() + 60_000)
      sqlite.exec("INSERT INTO catch_all_mailbox(domain,email_id) VALUES('example.com','catch')")
      if (scenario === "old address reused") {
        sessionRole = "emperor"
        sqlite.exec("UPDATE user_role SET role_id='emperor' WHERE user_id='owner'")
      }
      const response = await send.POST(sendRequest({
        to: "a@example.com", subject: "Subject", content: "Hello", fromLocalPart: "spoofed",
      }), sendParams(scenario === "old address reused" ? "email" : "catch"))

      assert.equal(response.status, 403)
      assert.equal(usedQuota(), 0)
      assert.equal(sentCount(), 0)
    })
  }
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
