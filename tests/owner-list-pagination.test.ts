import test, { after, beforeEach, mock } from "node:test"
import assert from "node:assert/strict"
import { drizzle } from "drizzle-orm/d1"
import * as schema from "../app/lib/schema"
import { createTestDatabase } from "./helpers/database"
import { encodeCursor } from "../app/lib/cursor"

const { sqlite, d1 } = createTestDatabase()
const db = drizzle(d1, { schema })
let sessionId: string | undefined = "owner"
mock.module("../app/lib/db.ts", { namedExports: { createDb: () => db } })
mock.module("next/headers", { namedExports: { headers: async () => new Headers() } })
mock.module("../app/lib/auth.ts", { namedExports: {
  GET: async () => Response.json(sessionId ? { user: { id: sessionId } } : null),
  auth: async () => sessionId ? { user: { id: sessionId } } : null,
  checkPermission: async () => sessionId === "owner",
  getUserRole: async () => "duke",
} })
const mailboxShares = await import("../app/api/emails/[id]/share/route")
const messageShares = await import("../app/api/emails/[id]/messages/[messageId]/share/route")
const apiKeys = await import("../app/api/api-keys/route")

type Page = { shares?: { id: string }[]; apiKeys?: { id: string; key: string }[]; total?: number; nextCursor: string | null }
const endpoints = [
  { name: "mailbox shares", denied: 404, list: (request: Request) => mailboxShares.GET(request, { params: Promise.resolve({ id: "email" }) }) },
  { name: "message shares", denied: 403, list: (request: Request) => messageShares.GET(request, { params: Promise.resolve({ id: "email", messageId: "message" }) }) },
  { name: "API keys", denied: 403, list: (request: Request) => apiKeys.GET(request) },
]

beforeEach(() => {
  sqlite.exec("DELETE FROM api_keys; DELETE FROM user; DELETE FROM role")
  sqlite.exec("INSERT INTO user(id) VALUES('owner'),('victim'); INSERT INTO role(id,name) VALUES('duke','duke'); INSERT INTO user_role(user_id,role_id) VALUES('owner','duke'),('victim','duke')")
  sqlite.prepare("INSERT INTO email(id,address,userId,created_at,expires_at) VALUES('email','owner@example.com','owner',0,?),('other','victim@example.com','victim',0,?)").run(Date.now() + 60_000, Date.now() + 60_000)
  sqlite.exec("INSERT INTO message(id,emailId,subject,content,received_at,sent_at) VALUES('message','email','s','c',0,0),('other','other','s','c',0,0)")
  sessionId = "owner"
})
after(() => sqlite.close())

function seed(id: string, owner = "owner", created = 1000, nullKeyDate = false) {
  const target = owner === "owner" ? "email" : "other"
  const message = owner === "owner" ? "message" : "other"
  sqlite.prepare("INSERT INTO email_share(id,email_id,token,created_at) VALUES(?,?,?,?)").run(id, target, `email-${id}`, created)
  sqlite.prepare("INSERT INTO message_share(id,message_id,token,created_at) VALUES(?,?,?,?)").run(id, message, `message-${id}`, created)
  sqlite.prepare("INSERT INTO api_keys(id,user_id,name,key,created_at) VALUES(?,?,?,?,?)").run(id, owner, id, `local-${id}`, nullKeyDate ? null : Math.floor(created / 1000))
}
const request = (cursor?: string) => new Request(`https://app.example.com/api/owner-list${cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`}`)

for (const endpoint of endpoints) {
  test(`${endpoint.name} are bounded to 100 and retain every older item through deterministic cursors`, async () => {
    const expected = Array.from({ length: 205 }, (_, index) => `row-${String(index).padStart(4, "0")}`).reverse()
    for (const [index, id] of expected.entries()) seed(id, "owner", endpoint.name === "API keys" ? 0 : 1000, index % 2 === 0)
    seed("foreign", "victim")
    let cursor: string | undefined
    const ids: string[] = []
    const pageSizes: number[] = []
    do {
      const response = await endpoint.list(request(cursor))
      assert.equal(response.status, 200)
      if (endpoint.name === "API keys") assert.equal(response.headers.get("Cache-Control"), "no-store")
      const page = await response.json() as Page
      const items = page.shares ?? page.apiKeys ?? []
      assert.ok(items.length <= 100)
      pageSizes.push(items.length)
      for (const item of items) {
        if (endpoint.name === "API keys") {
          assert.equal("key" in item && item.key === `local-${item.id}`, true, "API-key lists must return each owner’s stored value")
        }
        ids.push(item.id)
      }
      if (pageSizes.length === 1) {
        assert.ok(page.nextCursor)
        if (page.shares) assert.equal(page.total, 205)
        // A new head row must not shift the older-page boundary.
        seed("new-head", "owner", 9000)
      }
      cursor = page.nextCursor ?? undefined
      assert.ok(pageSizes.length <= 3, "pagination must make progress even with legacy NULL key dates")
    } while (cursor)
    assert.deepEqual(pageSizes, [100, 100, 5])
    assert.deepEqual(ids, expected)
    assert.equal(new Set(ids).size, 205)
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE user_id = 'owner'").get()?.n, 206)
  })

  test(`${endpoint.name} reject malformed cursors without changing persisted records`, async () => {
    seed("row")
    const malformed = ["", "not-json", "A".repeat(2049), Buffer.from("null").toString("base64"), Buffer.from("{}").toString("base64"), encodeCursor(1000, ""), encodeCursor(8_640_000_000_000_001, "row")]
    for (const cursor of malformed) assert.equal((await endpoint.list(request(cursor))).status, 400)
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM api_keys").get()?.n, 1)
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM email_share").get()?.n, 1)
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM message_share").get()?.n, 1)
  })

  test(`${endpoint.name} preserve permission and ownership checks before cursor validation`, async () => {
    seed("row")
    sessionId = "victim"
    assert.equal((await endpoint.list(request("malformed"))).status, endpoint.denied)
    sessionId = undefined
    assert.equal((await endpoint.list(request("malformed"))).status, endpoint.name === "API keys" ? 403 : 401)
  })
}
