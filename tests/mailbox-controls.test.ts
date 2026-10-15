import test, { after, beforeEach, mock } from "node:test"
import assert from "node:assert/strict"
import { drizzle } from "drizzle-orm/d1"
import * as schema from "../app/lib/schema"
import { createTestDatabase } from "./helpers/database"
import { decodeArrivalCursor, encodeArrivalCursor, encodeCursor } from "../app/lib/cursor"

const { sqlite, d1 } = createTestDatabase()
const db = drizzle(d1, { schema })
const config = new Map<string, string>()
let userId: string | undefined = "owner"
mock.module("../app/lib/db.ts", { namedExports: { createDb: () => db } })
mock.module("../app/lib/apiKey.ts", { namedExports: { getUserId: async () => userId } })
mock.module("../app/lib/send-permissions.ts", { namedExports: { checkBasicSendPermission: async () => ({ canSend: true }) } })
mock.module("@opennextjs/cloudflare", { namedExports: { getCloudflareContext: () => ({ env: {
  DB: d1, SITE_CONFIG: { get: async (key: string) => config.get(key) ?? null },
} }) } })
const mailboxes = await import("../app/api/emails/route")
const mailbox = await import("../app/api/emails/[id]/route")
const detail = await import("../app/api/emails/[id]/[messageId]/route")
after(() => sqlite.close())
beforeEach(() => {
  sqlite.exec("DELETE FROM user; INSERT INTO user(id) VALUES('owner'),('other')")
  userId = "owner"
  config.clear()
  config.set("EMAIL_DOMAINS", "example.com,example.org")
  sqlite.prepare("INSERT INTO email(id,address,userId,created_at,expires_at) VALUES('box','owner@example.com','owner',0,?)").run(Date.now() + 60_000)
})
const request = (query = "") => new Request(`https://app.example.test/api/emails/box${query}`)
const params = () => ({ params: Promise.resolve({ id: "box" }) })
function insertMessage(id: string, time: number, read = 0, type = "received") {
  sqlite.prepare("INSERT INTO message(id,emailId,subject,content,received_at,sent_at,is_read,type) VALUES(?,'box',?,'body',?,?,?,?)")
    .run(id, id, time, time, read, type)
}

test("mailbox list aggregates received counts and filters domains before pagination", async () => {
  insertMessage("unread", 10)
  insertMessage("read", 20, 1)
  insertMessage("sent", 30, 0, "sent")
  const response = await mailboxes.GET(request("?domain=EXAMPLE.com"))
  const data = await response.json() as { emails: { id: string; totalMessages: number; unreadMessages: number }[]; total: number }
  assert.equal(data.total, 1)
  assert.deepEqual(data.emails.map(({ id, totalMessages, unreadMessages }) => ({ id, totalMessages, unreadMessages })), [
    { id: "box", totalMessages: 2, unreadMessages: 1 },
  ])
  assert.equal((await (await mailboxes.GET(request("?domain=example.org"))).json() as { emails: unknown[] }).emails.length, 0)
})

test("Catch-all stays pinned once across mailbox pages and remains protected from deletion", async () => {
  config.set("CATCHALL_EMAIL", JSON.stringify({ "example.com": { address: "owner@example.com", enabled: true, showAlways: true } }))
  for (let index = 0; index < 23; index++) {
    sqlite.prepare("INSERT INTO email(id,address,userId,created_at,expires_at) VALUES(?,?,'owner',?,?)")
      .run(`box-${index}`, `box-${index}@example.com`, 100 + index, Date.now() + 60_000)
  }
  const first = await (await mailboxes.GET(request())).json() as { emails: { id: string; isCatchAll: boolean }[]; nextCursor: string; total: number }
  assert.equal(first.emails[0].id, "box")
  assert.equal(first.emails[0].isCatchAll, true)
  const second = await (await mailboxes.GET(request(`?cursor=${encodeURIComponent(first.nextCursor)}`))).json() as typeof first
  assert.equal(new Set([...first.emails, ...second.emails].map(email => email.id)).size, 24)
  assert.equal(second.emails.some(email => email.id === "box"), false)
  assert.equal((await mailbox.DELETE(request(), params())).status, 403)
})

test("disabled hidden Catch-all is excluded without hiding normal mailboxes", async () => {
  config.set("CATCHALL_EMAIL", JSON.stringify({ "example.com": { address: "owner@example.com", enabled: false, showAlways: false } }))
  const data = await (await mailboxes.GET(request())).json() as { total: number; emails: unknown[] }
  assert.equal(data.total, 0)
  assert.equal(data.emails.length, 0)
})

test("registered Catch-all stays pinned and protected when KV retains its pre-rename address", async () => {
  config.set("CATCHALL_EMAIL", JSON.stringify({ "example.com": { address: "owner@example.com", enabled: true, showAlways: true } }))
  sqlite.exec("UPDATE email SET address = 'renamed@example.com' WHERE id = 'box'; INSERT INTO catch_all_mailbox(domain,email_id) VALUES('example.com','box')")
  insertMessage("preserved", 100)
  for (let index = 0; index < 21; index++) {
    sqlite.prepare("INSERT INTO email(id,address,userId,created_at,expires_at) VALUES(?,?,'owner',?,?)")
      .run(`ordinary-${index}`, `ordinary-${index}@example.com`, index + 1, Date.now() + 60_000)
  }
  const first = await (await mailboxes.GET(request("?domain=example.com"))).json() as {
    emails: { id: string; isCatchAll: boolean }[]; nextCursor: string; total: number
  }
  assert.equal(first.total, 22)
  assert.deepEqual(first.emails[0].id, "box")
  assert.equal(first.emails[0].isCatchAll, true)
  const second = await (await mailboxes.GET(request(`?cursor=${encodeURIComponent(first.nextCursor)}`))).json() as typeof first
  assert.equal(second.emails.some(email => email.id === "box"), false)
  assert.equal(new Set([...first.emails, ...second.emails].map(email => email.id)).size, 22)
  assert.equal((await mailbox.DELETE(request(), params())).status, 403)
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM message WHERE id='preserved'").get()?.count, 1)
  assert.equal(sqlite.prepare("SELECT address FROM email WHERE id='box'").get()?.address, "renamed@example.com")

  config.set("CATCHALL_EMAIL", JSON.stringify({ "example.com": { address: "owner@example.com", enabled: false, showAlways: false } }))
  const hidden = await (await mailboxes.GET(request())).json() as typeof first
  assert.equal(hidden.total, 21)
  assert.equal(hidden.emails.some(email => email.id === "box"), false)

  config.delete("CATCHALL_EMAIL")
  const missing = await (await mailboxes.GET(request())).json() as typeof first
  assert.equal(missing.emails[0].isCatchAll, true)
  assert.equal((await mailbox.DELETE(request(), params())).status, 403)
})

test("deleting a stale unread row returns authoritative received counts after a cross-session read", async () => {
  insertMessage("stale-unread", 100)
  insertMessage("remaining-unread", 101)
  insertMessage("sent", 102, 0, "sent")
  const initial = await (await mailbox.GET(request(), params())).json() as {
    messages: { id: string; is_read: boolean }[]; latestCursor: string
  }
  assert.equal(initial.messages.find(message => message.id === "stale-unread")?.is_read, false)
  sqlite.exec("UPDATE message SET is_read = 1 WHERE id='stale-unread'")
  const poll = await (await mailbox.GET(request(`?since=${encodeURIComponent(initial.latestCursor)}`), params())).json() as {
    messages: unknown[]; total: number; unread: number
  }
  assert.deepEqual(poll.messages, [])
  assert.equal(poll.unread, 1)
  const deletion = await detail.DELETE(request(), { params: Promise.resolve({ id: "box", messageId: "stale-unread" }) })
  assert.equal(deletion.status, 200)
  assert.deepEqual(await deletion.json(), { success: true, total: 1, unread: 1 })
  assert.equal(sqlite.prepare("SELECT is_read FROM message WHERE id='remaining-unread'").get()?.is_read, 0)
  const sentDeletion = await detail.DELETE(request(), { params: Promise.resolve({ id: "box", messageId: "sent" }) })
  assert.deepEqual(await sentDeletion.json(), { success: true })
  const lastDeletion = await detail.DELETE(request(), { params: Promise.resolve({ id: "box", messageId: "remaining-unread" }) })
  assert.deepEqual(await lastDeletion.json(), { success: true, total: 0, unread: 0 })
})

test("incremental cursor drains more than one page with tied timestamps without losing messages", async () => {
  for (let index = 0; index < 45; index++) insertMessage(`message-${String(index).padStart(2, "0")}`, 100)
  let since = encodeCursor(99, "")
  const ids: string[] = []
  let hasMore = true
  while (hasMore) {
    const data = await (await mailbox.GET(request(`?since=${encodeURIComponent(since)}`), params())).json() as {
      messages: { id: string }[]; latestCursor: string; hasMore: boolean; total?: number
    }
    assert.equal(data.total, 45)
    ids.push(...data.messages.map(message => message.id))
    since = data.latestCursor
    hasMore = data.hasMore
  }
  assert.equal(ids.length, 45)
  assert.equal(new Set(ids).size, 45)
  assert.ok(decodeArrivalCursor(since) > 0)
  const empty = await (await mailbox.GET(request(`?since=${encodeURIComponent(since)}`), params())).json() as { messages: unknown[]; latestCursor: string }
  assert.equal(empty.messages.length, 0)
  assert.equal(empty.latestCursor, since)
})

test("opening an owned received message marks it read once; unauthorized reads cannot change it", async () => {
  insertMessage("unread", 100)
  insertMessage("still-unread", 101)
  const detailParams = { params: Promise.resolve({ id: "box", messageId: "unread" }) }
  userId = "other"
  assert.equal((await detail.GET(request(), detailParams)).status, 403)
  assert.equal(sqlite.prepare("SELECT is_read FROM message WHERE id='unread'").get()?.is_read, 0)
  userId = "owner"
  const first = await (await detail.GET(request(), detailParams)).json() as { wasUnread: boolean; total: number; unread: number }
  assert.equal(first.wasUnread, true)
  assert.equal(sqlite.prepare("SELECT is_read FROM message WHERE id='unread'").get()?.is_read, 1)
  const repeated = await (await detail.GET(request(), detailParams)).json() as typeof first
  assert.equal(repeated.wasUnread, false)
  assert.equal(repeated.total, 2)
  assert.equal(repeated.unread, 1)
})

test("incremental polling includes smaller UUIDs and earlier timestamps committed after the snapshot", async () => {
  for (const type of ["received", "sent"]) {
    insertMessage(`z-${type}`, 100, 0, type)
    const typeQuery = type === "sent" ? "?type=sent" : ""
    const initial = await (await mailbox.GET(request(typeQuery), params())).json() as { latestCursor: string }
    insertMessage(`a-${type}`, 100, 0, type)
    insertMessage(`earlier-${type}`, 1, 0, type)
    const separator = typeQuery ? "&" : "?"
    const poll = await (await mailbox.GET(request(`${typeQuery}${separator}since=${encodeURIComponent(initial.latestCursor)}`), params())).json() as {
      messages: { id: string; content?: string; html?: string }[]; latestCursor: string
    }
    assert.deepEqual(poll.messages.map(message => message.id), [`a-${type}`, `earlier-${type}`])
    assert.ok(poll.messages.every(message => message.content === undefined && message.html === undefined))
  }
})

test("arrival watermarks survive deletion of all messages and do not reuse their sequence", async () => {
  insertMessage("old", 500)
  const initial = await (await mailbox.GET(request(), params())).json() as { latestCursor: string }
  sqlite.exec("DELETE FROM message")
  insertMessage("replacement", 1)
  const poll = await (await mailbox.GET(request(`?since=${encodeURIComponent(initial.latestCursor)}`), params())).json() as {
    messages: { id: string }[]; latestCursor: string
  }
  assert.deepEqual(poll.messages.map(message => message.id), ["replacement"])
  assert.ok(decodeArrivalCursor(poll.latestCursor) > decodeArrivalCursor(initial.latestCursor))
})

test("late arrivals remain reachable while draining multiple incremental pages", async () => {
  for (let index = 0; index < 45; index++) insertMessage(`z-${index}`, 100)
  let since = encodeArrivalCursor(0)
  const ids: string[] = []
  let hasMore = true
  while (hasMore) {
    const page = await (await mailbox.GET(request(`?since=${encodeURIComponent(since)}`), params())).json() as {
      messages: { id: string }[]; latestCursor: string; hasMore: boolean
    }
    ids.push(...page.messages.map(message => message.id))
    since = page.latestCursor
    hasMore = page.hasMore
    if (ids.length === 20) insertMessage("a-late", 1)
  }
  assert.equal(ids.length, 46)
  assert.equal(new Set(ids).size, 46)
  assert.equal(ids.at(-1), "a-late")
})


test("an empty snapshot cursor includes mail inserted before the response finishes", async t => {
  const findMany = db.query.messages.findMany.bind(db.query.messages)
  const query = t.mock.method(db.query.messages, "findMany", async (...args: Parameters<typeof findMany>) => {
    const rows = await findMany(...args)
    insertMessage("arrived-after-snapshot", Date.now() - 1)
    return rows
  })
  const initial = await (await mailbox.GET(request(), params())).json() as {
    messages: unknown[]; latestCursor: string
  }
  query.mock.restore()
  assert.deepEqual(initial.messages, [])
  const poll = await (await mailbox.GET(request(`?since=${encodeURIComponent(initial.latestCursor)}`), params())).json() as {
    messages: { id: string }[]; total: number; unread: number
  }
  assert.deepEqual(poll.messages.map(message => message.id), ["arrived-after-snapshot"])
  assert.equal(poll.total, 1)
  assert.equal(poll.unread, 1)
})

test("incremental polls return current aggregate counts even after a mailbox-list refresh or empty delta", async () => {
  insertMessage("original", 100)
  const initial = await (await mailbox.GET(request(), params())).json() as { latestCursor: string }
  insertMessage("new", 200)
  insertMessage("sent", 300, 0, "sent")
  const refreshed = await (await mailboxes.GET(request())).json() as {
    emails: { totalMessages: number; unreadMessages: number }[]
  }
  const poll = await (await mailbox.GET(request(`?since=${encodeURIComponent(initial.latestCursor)}`), params())).json() as {
    messages: { id: string }[]; latestCursor: string; total: number; unread: number
  }
  assert.deepEqual(poll.messages.map(message => message.id), ["new"])
  assert.equal(poll.total, refreshed.emails[0].totalMessages)
  assert.equal(poll.unread, refreshed.emails[0].unreadMessages)
  sqlite.exec("UPDATE message SET is_read = 1 WHERE id = 'new'")
  const emptyPoll = await (await mailbox.GET(request(`?since=${encodeURIComponent(poll.latestCursor)}`), params())).json() as typeof poll
  assert.deepEqual(emptyPoll.messages, [])
  assert.equal(emptyPoll.total, 2)
  assert.equal(emptyPoll.unread, 1)
})
