import test, { after, beforeEach, mock } from "node:test"
import assert from "node:assert/strict"
import { drizzle } from "drizzle-orm/d1"
import * as schema from "../app/lib/schema"
import { createTestDatabase } from "./helpers/database"
import emailReceiver from "../workers/email-receiver"
import type { Env } from "../types"

const { sqlite, d1 } = createTestDatabase()
const db = drizzle(d1, { schema })
let activeUserId = "emperor"
const config = new Map<string, string>()
const configReads = new Set<string>()
const siteConfig = {
  get: async (key: string) => {
    configReads.add(key)
    return config.get(key) ?? null
  },
  put: async (key: string, value: string) => { config.set(key, value) },
  delete: async (key: string) => { config.delete(key) },
}

mock.module("../app/lib/db.ts", { namedExports: { createDb: () => db } })
mock.module("next/headers", { namedExports: { headers: async () => new Headers() } })
mock.module("@opennextjs/cloudflare", {
  namedExports: { getCloudflareContext: () => ({ env: { DB: d1, SITE_CONFIG: siteConfig } }) },
})
mock.module("../app/lib/auth.ts", {
  namedExports: {
    GET: async () => Response.json({ user: { id: activeUserId } }),
    auth: async () => ({ user: { id: activeUserId } }),
    checkPermission: async () => activeUserId === "emperor",
    getUserRole: async (userId: string) => userId === "emperor" ? "emperor" : "civilian",
  },
})

const configRoute = await import("../app/api/config/route")

function reset() {
  activeUserId = "emperor"
  config.clear()
  configReads.clear()
  config.set("EMAIL_DOMAINS", "example.com")
  sqlite.exec("DELETE FROM user; DELETE FROM role")
  sqlite.exec("INSERT INTO user(id) VALUES ('emperor'), ('member'), ('other')")
  sqlite.exec("INSERT INTO role(id, name) VALUES ('emperor-role', 'emperor'), ('civilian-role', 'civilian')")
  sqlite.exec("INSERT INTO user_role(user_id, role_id) VALUES ('emperor', 'emperor-role'), ('member', 'civilian-role'), ('other', 'civilian-role')")
}

beforeEach(reset)
after(() => sqlite.close())

const baseConfig = {
  defaultRole: "civilian",
  emailDomains: "example.com",
  adminContact: "",
  maxEmails: "10",
}

function saveConfig(catchAll?: unknown, emailDomains = baseConfig.emailDomains) {
  return configRoute.POST(new Request("https://app.example.com/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...baseConfig,
      emailDomains,
      ...(catchAll === undefined ? {} : { catchAll }),
    }),
  }))
}

test("Catch-all save creates an emperor-owned permanent mailbox and preserves per-domain state", async () => {
  config.set("EMAIL_DOMAINS", "example.com, example.org")
  const response = await saveConfig({
    domains: {
      "example.com": { enabled: true, showAlways: false, mailboxName: "Inbox" },
      "example.org": { enabled: false, showAlways: false, mailboxName: "Archive" },
    },
  }, "example.com, example.org")

  assert.equal(response.status, 200)
  const inbox = sqlite.prepare("SELECT id, userId, expires_at FROM email WHERE address = ?").get("inbox@example.com") as {
    id: string
    userId: string
    expires_at: number
  }
  assert.ok(inbox.id)
  assert.equal(inbox.userId, "emperor")
  assert.equal(inbox.expires_at, new Date("9999-01-01T00:00:00.000Z").getTime())
  assert.equal(sqlite.prepare("SELECT userId FROM email WHERE address = ?").get("archive@example.org")?.userId, "emperor")
  assert.deepEqual(JSON.parse(config.get("CATCHALL_EMAIL")!), {
    "example.com": { address: "inbox@example.com", enabled: true, showAlways: false },
    "example.org": { address: "archive@example.org", enabled: false, showAlways: false },
  })

  const settings = await (await configRoute.GET()).json() as {
    catchAll: { domains: Record<string, { enabled: boolean; showAlways: boolean; mailboxName: string }> }
  }
  assert.deepEqual(settings.catchAll.domains, {
    "example.com": { enabled: true, showAlways: false, mailboxName: "inbox" },
    "example.org": { enabled: false, showAlways: false, mailboxName: "archive" },
  })
})

test("Catch-all cannot claim a mailbox owned by another user", async () => {
  sqlite.prepare("INSERT INTO email(id, address, userId, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
    .run("other-mailbox", "taken@example.com", "other", Date.now(), Date.now() + 60_000)

  const response = await saveConfig({
    domains: { "example.com": { enabled: true, showAlways: true, mailboxName: "taken" } },
  })

  assert.equal(response.status, 409)
  assert.equal((await response.json() as { code: string }).code, "CATCH_ALL_ADDRESS_OCCUPIED")
  assert.equal(sqlite.prepare("SELECT userId FROM email WHERE id = ?").get("other-mailbox")?.userId, "other")
  assert.equal(config.has("CATCHALL_EMAIL"), false)
})

test("renaming a configured Catch-all preserves its mailbox record", async () => {
  const firstSave = await saveConfig({
    domains: { "example.com": { enabled: true, showAlways: true, mailboxName: "inbox" } },
  })
  assert.equal(firstSave.status, 200)
  const before = sqlite.prepare("SELECT id FROM email WHERE address = ?").get("inbox@example.com") as { id: string }

  const rename = await saveConfig({
    domains: { "example.com": { enabled: false, showAlways: false, mailboxName: "archive" } },
  })

  assert.equal(rename.status, 200)
  const after = sqlite.prepare("SELECT id, expires_at FROM email WHERE address = ?").get("archive@example.com") as {
    id: string
    expires_at: number
  }
  assert.equal(after.id, before.id)
  assert.equal(after.expires_at, new Date("9999-01-01T00:00:00.000Z").getTime())
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM email WHERE address = ?").get("inbox@example.com")?.count, 0)
})

test("Catch-all rejects invalid mailbox prefixes without creating mailboxes", async () => {
  for (const mailboxName of ["two words", ".leading", "trailing.", "double..dot", "a".repeat(65), "name@other.test"]) {
    const response = await saveConfig({
      domains: { "example.com": { enabled: true, showAlways: true, mailboxName } },
    })
    assert.equal(response.status, 400, mailboxName)
    assert.equal((await response.json() as { code: string }).code, "INVALID_CATCH_ALL_MAILBOX_NAME")
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM email").get()?.count, 0)
    assert.equal(config.has("CATCHALL_EMAIL"), false)
  }
})

test("non-emperors do not receive privileged Catch-all or Turnstile settings", async () => {
  activeUserId = "member"
  config.set("CATCHALL_EMAIL", JSON.stringify({
    "example.com": { address: "inbox@example.com", enabled: true, showAlways: true },
  }))
  config.set("TURNSTILE_ENABLED", "true")
  config.set("TURNSTILE_SITE_KEY", "site-secret")
  config.set("TURNSTILE_SECRET_KEY", "private-secret")

  const response = await configRoute.GET()
  const body = await response.json() as Record<string, unknown>
  assert.equal(Object.hasOwn(body, "catchAll"), false)
  assert.equal(Object.hasOwn(body, "turnstile"), false)
  assert.deepEqual([...configReads].sort(), ["ADMIN_CONTACT", "DEFAULT_ROLE", "EMAIL_DOMAINS", "MAX_EMAILS"])
})

test("legacy config saves that omit Catch-all preserve its stored settings", async () => {
  const savedCatchAll = JSON.stringify({
    "example.com": { address: "inbox@example.com", enabled: false, showAlways: false },
  })
  config.set("CATCHALL_EMAIL", savedCatchAll)

  const response = await saveConfig()

  assert.equal(response.status, 200)
  assert.equal(config.get("CATCHALL_EMAIL"), savedCatchAll)
})


test("Catch-all missing mailbox names return a stable localization code", async () => {
  const response = await saveConfig({
    domains: { "example.com": { enabled: true, showAlways: true, mailboxName: "" } },
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json() as { code: string }).code, "CATCH_ALL_MAILBOX_NAME_REQUIRED")
})

test("a concurrent Catch-all address collision returns the same localization code", async t => {
  t.mock.method(d1, "batch", async () => {
    throw new Error("UNIQUE constraint failed: email.address")
  })
  const response = await saveConfig({
    domains: { "example.com": { enabled: true, showAlways: true, mailboxName: "inbox" } },
  })
  assert.equal(response.status, 409)
  assert.equal((await response.json() as { code: string }).code, "CATCH_ALL_ADDRESS_OCCUPIED")
  assert.equal(config.has("CATCHALL_EMAIL"), false)
})

async function receiveUnknownMail() {
  const rejected: string[] = []
  await emailReceiver.email({
    from: "sender@example.test",
    to: "unknown@example.com",
    raw: new Response("From: sender@example.test\r\nSubject: interleaved\r\n\r\nbody").body!,
    setReject: (reason: string) => rejected.push(reason),
  } as unknown as ForwardableEmailMessage, { DB: d1, SITE_CONFIG: siteConfig } as unknown as Env)
  return rejected
}

test("legacy Catch-all renames keep receiving through stale KV before and after a failed save", async t => {
  sqlite.prepare("INSERT INTO email(id,address,userId,created_at,expires_at) VALUES('legacy','old@example.com','emperor',0,?)")
    .run(new Date("9999-01-01").getTime())
  sqlite.exec("INSERT INTO message(id,emailId,subject,content,received_at,sent_at) VALUES('old-message','legacy','old','body',1,1)")
  const oldConfig = JSON.stringify({
    "example.com": { address: "old@example.com", enabled: true, showAlways: true },
  })
  config.set("CATCHALL_EMAIL", oldConfig)
  const put = siteConfig.put
  let fail = true
  t.mock.method(console, "error", () => {})
  const save = t.mock.method(siteConfig, "put", async (key: string, value: string) => {
    if (key === "CATCHALL_EMAIL") {
      assert.equal(config.get(key), oldConfig)
      assert.equal(sqlite.prepare("SELECT address FROM email WHERE id='legacy'").get()?.address, "new@example.com")
      assert.deepEqual(await receiveUnknownMail(), [])
      if (fail) throw new Error("synthetic KV failure")
    }
    await put(key, value)
  })
  const settings = { domains: { "example.com": { enabled: true, showAlways: true, mailboxName: "new" } } }
  assert.equal((await saveConfig(settings)).status, 500)
  assert.equal(config.get("CATCHALL_EMAIL"), oldConfig)
  assert.deepEqual(await receiveUnknownMail(), [])
  fail = false
  assert.equal((await saveConfig(settings)).status, 200)
  save.mock.restore()
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM email").get()?.n, 1)
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM message WHERE emailId='legacy'").get()?.n, 4)
  assert.equal(sqlite.prepare("SELECT email_id FROM catch_all_mailbox WHERE domain='example.com'").get()?.email_id, "legacy")
})

test("initial Catch-all creation retries recover the same mailbox after a KV failure", async t => {
  const put = siteConfig.put
  const failedPut = t.mock.method(siteConfig, "put", async (key: string, value: string) => {
    if (key === "CATCHALL_EMAIL") throw new Error("synthetic KV failure")
    await put(key, value)
  })
  t.mock.method(console, "error", () => {})
  const settings = { domains: { "example.com": { enabled: true, showAlways: true, mailboxName: "inbox" } } }
  assert.equal((await saveConfig(settings)).status, 500)
  assert.equal(config.has("CATCHALL_EMAIL"), false)
  const created = sqlite.prepare("SELECT id FROM email WHERE address='inbox@example.com'").get()?.id
  assert.ok(created)
  failedPut.mock.restore()
  assert.equal((await saveConfig(settings)).status, 200)
  assert.equal(sqlite.prepare("SELECT id FROM email WHERE address='inbox@example.com'").get()?.id, created)
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM email").get()?.n, 1)
  assert.deepEqual(await receiveUnknownMail(), [])
  assert.equal(sqlite.prepare("SELECT emailId FROM message").get()?.emailId, created)
})
