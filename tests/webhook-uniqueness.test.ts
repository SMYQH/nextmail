import test, { after, beforeEach, mock } from "node:test"
import assert from "node:assert/strict"
import { drizzle } from "drizzle-orm/d1"
import { DatabaseSync } from "node:sqlite"
import { readFileSync, readdirSync } from "node:fs"
import * as schema from "../app/lib/schema"
import { createTestDatabase } from "./helpers/database"

const { sqlite, d1 } = createTestDatabase()
const db = drizzle(d1, { schema })
let sessionId: string | undefined
const config = new Map<string, string>()

mock.module("../app/lib/db.ts", { namedExports: { createDb: () => db } })
mock.module("next/headers", { namedExports: { headers: async () => new Headers() } })
mock.module("@opennextjs/cloudflare", { namedExports: { getCloudflareContext: () => ({ env: { DB: d1, SITE_CONFIG: { get: async (key: string) => config.get(key) ?? null } } }) } })
mock.module("../app/lib/auth.ts", { namedExports: { GET: async () => Response.json(sessionId ? { user: { id: sessionId } } : null), auth: async () => sessionId ? { user: { id: sessionId } } : null, getUserRole: async () => "duke", checkPermission: async () => sessionId === "owner" } })

const webhook = await import("../app/api/webhook/route")

beforeEach((t) => {
  assert.ok("mock" in t)
  config.clear()
  const previous = process.env.WEBHOOK_ALLOWED_HOSTS
  process.env.WEBHOOK_ALLOWED_HOSTS = "hooks.example.com"
  t.after(() => {
    if (previous === undefined) delete process.env.WEBHOOK_ALLOWED_HOSTS
    else process.env.WEBHOOK_ALLOWED_HOSTS = previous
  })
  sqlite.exec("DELETE FROM webhook; DELETE FROM user")
  sqlite.exec("INSERT INTO user(id) VALUES('owner')")
  sessionId = "owner"
})
after(() => sqlite.close())

function request(url: string, enabled: boolean) {
  return new Request("https://app.example.com/api/webhook", {
    method: "POST",
    body: JSON.stringify({ url, enabled }),
  })
}

test("the webhook migration collapses duplicate rows to the newest one per user", () => {
  const legacy = new DatabaseSync(":memory:", { enableDoubleQuotedStringLiterals: true })
  legacy.exec("PRAGMA foreign_keys = ON")
  for (const file of readdirSync("drizzle").filter(name => name.endsWith(".sql")).sort()) {
    if (file >= "0023_webhook_user_unique.sql") continue
    for (const statement of readFileSync(`drizzle/${file}`, "utf8").split("--> statement-breakpoint")) {
      const trimmed = statement.trim()
      if (trimmed) legacy.exec(trimmed)
    }
  }
  legacy.exec("INSERT INTO user(id) VALUES('owner'),('someone-else')")
  legacy.exec("INSERT INTO webhook(id,user_id,url,secret,enabled,created_at,updated_at) VALUES('old','owner','https://old.example.com/e','old-secret',1,10,10)")
  legacy.exec("INSERT INTO webhook(id,user_id,url,secret,enabled,created_at,updated_at) VALUES('new','owner','https://new.example.com/e','new-secret',1,20,20)")
  legacy.exec("INSERT INTO webhook(id,user_id,url,secret,enabled,created_at,updated_at) VALUES('other','someone-else','https://other.example.com/e','other-secret',1,30,30)")

  for (const statement of readFileSync("drizzle/0023_webhook_user_unique.sql", "utf8").split("--> statement-breakpoint")) {
    const trimmed = statement.trim()
    if (trimmed) legacy.exec(trimmed)
  }

  const rows = legacy.prepare("SELECT id, url, secret FROM webhook ORDER BY id").all()
  assert.deepEqual(rows.map(row => row.id), ["new", "other"])
  assert.equal(rows.find(row => row.id === "new")?.url, "https://new.example.com/e")
  assert.throws(
    () => legacy.exec("INSERT INTO webhook(id,user_id,url,secret,enabled,created_at,updated_at) VALUES('extra','owner','https://x.example.com/e','s',1,40,40)"),
    /UNIQUE constraint failed: webhook.user_id/
  )
  legacy.close()
})

test("saving a webhook twice keeps a single row and preserves the signing secret", async () => {
  const url = "https://hooks.example.com/event"
  assert.equal((await webhook.POST(request(url, true))).status, 200)
  const first = sqlite.prepare("SELECT id, secret FROM webhook WHERE user_id = 'owner'").get() as { id: string; secret: string }

  assert.equal((await webhook.POST(request(url, false))).status, 200)

  const rows = sqlite.prepare("SELECT id, secret, url, enabled FROM webhook WHERE user_id = 'owner'").all()
  assert.equal(rows.length, 1)
  assert.equal((rows[0] as { id: string }).id, first.id)
  assert.equal((rows[0] as { secret: string }).secret, first.secret)
  assert.equal((rows[0] as { url: string }).url, url)
  assert.equal((rows[0] as { enabled: number }).enabled, 0)
})

test("a disabled webhook stays readable and reports its configuration", async () => {
  const url = "https://hooks.example.com/event"
  await webhook.POST(request(url, true))
  const signingSecret = sqlite.prepare("SELECT secret FROM webhook WHERE user_id = 'owner'").get()?.secret
  assert.equal(typeof signingSecret, "string")
  await webhook.POST(request(url, false))

  const payload = await (await webhook.GET()).json() as { enabled: boolean; url: string }
  assert.equal(payload.enabled, false)
  assert.equal(payload.url, url)
  assert.equal(sqlite.prepare("SELECT secret FROM webhook WHERE user_id = 'owner'").get()?.secret, signingSecret)
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM webhook WHERE user_id = 'owner'").get()?.n, 1)
})
