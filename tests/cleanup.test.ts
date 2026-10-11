import test from "node:test"
import assert from "node:assert/strict"
import cleanup from "../workers/cleanup"
import { createTestDatabase } from "./helpers/database"

// Exercise empty, exact-batch, partial-batch and multiple-batch cases through the real worker.
for (const count of [0, 1, 99, 100, 101, 251]) {
  test(`cleanup removes ${count} expired mailboxes and preserves active records`, async t => {
    const { sqlite, d1 } = createTestDatabase()
    t.after(() => sqlite.close())
    const now = 1_800_000_000_000
    t.mock.method(Date, "now", () => now)
    t.mock.method(console, "info", () => {})
    const mailbox = sqlite.prepare("INSERT INTO email(id,address,created_at,expires_at) VALUES(?,?,0,?)")
    const message = sqlite.prepare("INSERT INTO message(id,emailId,subject,content,received_at,sent_at) VALUES(?,?,'s','c',0,0)")
    const emailShare = sqlite.prepare("INSERT INTO email_share(id,email_id,token,created_at) VALUES(?,?,?,0)")
    const messageShare = sqlite.prepare("INSERT INTO message_share(id,message_id,token,created_at) VALUES(?,?,?,0)")
    function seed(id: string, expires: number) {
      mailbox.run(id, `${id}@example.com`, expires)
      message.run(id, id)
      emailShare.run(id, id, id)
      messageShare.run(id, id, id)
    }
    // Expiration is inclusive: items expiring exactly now must also disappear.
    for (let i = 0; i < count; i++) seed(`expired-${i}`, now - i)
    seed("active", now + 1)
    seed("permanent", 8_640_000_000_000_000)
    const query = t.mock.method(d1, "prepare")
    await cleanup.scheduled({} as ScheduledEvent, { DB: d1 })
    assert.equal(query.mock.callCount(), Math.floor(count / 100) + 1)
    for (const table of ["email", "message", "email_share", "message_share"]) {
      assert.deepEqual(sqlite.prepare(`SELECT id FROM ${table} ORDER BY id`).all().map(row => row.id), ["active", "permanent"], table)
    }
    await cleanup.scheduled({} as ScheduledEvent, { DB: d1 })
    assert.deepEqual(sqlite.prepare("SELECT id FROM email ORDER BY id").all().map(row => row.id), ["active", "permanent"])
  })
}

test("cleanup propagates database failures instead of reporting completion", async t => {
  for (const failure of ["unsuccessful result", "rejected query"]) {
    await t.test(failure, async t => {
      const info = t.mock.method(console, "info", () => {})
      const databaseError = new Error("Database unavailable")
      let queries = 0
      const d1 = {
        prepare: () => ({ bind: () => ({ all: async () => {
          queries++
          if (failure === "rejected query") throw databaseError
          return { success: false, results: [] }
        } }) }),
      } as unknown as D1Database
      await assert.rejects(cleanup.scheduled({} as ScheduledEvent, { DB: d1 }),
        failure === "rejected query" ? databaseError : /Expired email cleanup failed/)
      assert.equal(queries, 1)
      assert.equal(info.mock.callCount(), 0)
    })
  }
})
