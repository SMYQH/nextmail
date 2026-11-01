import test from "node:test"
import assert from "node:assert/strict"
import cleanup from "../workers/cleanup"
import { createTestDatabase } from "./helpers/database"

// Assert the budget as an independent contract; keep the Worker entrypoint exports unchanged.
const CLEANUP_BATCH_SIZE = 100
const CLEANUP_MAX_BATCHES = 10

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
    assert.equal(query.mock.callCount(), Math.min(Math.floor(count / CLEANUP_BATCH_SIZE) + 1, CLEANUP_MAX_BATCHES) + 3)
    for (const table of ["email", "message", "email_share", "message_share"]) {
      assert.deepEqual(sqlite.prepare(`SELECT id FROM ${table} ORDER BY id`).all().map(row => row.id), ["active", "permanent"], table)
    }
    await cleanup.scheduled({} as ScheduledEvent, { DB: d1 })
    assert.deepEqual(sqlite.prepare("SELECT id FROM email ORDER BY id").all().map(row => row.id), ["active", "permanent"])
  })
}

const budget = CLEANUP_BATCH_SIZE * CLEANUP_MAX_BATCHES
for (const count of [budget, budget + 1, budget * 2 + 1]) {
  test(`cleanup bounds ${count} expired mailboxes and resumes the persisted backlog`, async t => {
    const { sqlite, d1 } = createTestDatabase()
    t.after(() => sqlite.close())
    const now = 1_800_000_000_000
    t.mock.method(Date, "now", () => now)
    const info = t.mock.method(console, "info", () => {})
    const warning = t.mock.method(console, "warn", () => {})
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
    for (let index = 0; index < count; index++) seed(`expired-${index}`, now - index)
    seed("active", now + 1)
    seed("permanent", 8_640_000_000_000_000)
    const query = t.mock.method(d1, "prepare")
    let remaining = count
    while (remaining > 0) {
      const previousQueries = query.mock.callCount()
      const previousWarnings = warning.mock.callCount()
      const expectedQueries = Math.min(Math.floor(remaining / CLEANUP_BATCH_SIZE) + 1, CLEANUP_MAX_BATCHES)
      const deleted = Math.min(remaining, budget)
      await cleanup.scheduled({} as ScheduledEvent, { DB: d1 })
      remaining -= deleted
      assert.equal(query.mock.callCount() - previousQueries, expectedQueries + 3)
      assert.deepEqual(info.mock.calls.at(-2)?.arguments[1], {
        deleted, batches: expectedQueries, backlogMayRemain: deleted === budget,
      })
      assert.equal(warning.mock.callCount() - previousWarnings, deleted === budget ? 1 : 0)
      if (deleted === budget) assert.match(String(warning.mock.calls.at(-1)?.arguments[0]), /batch limit/)
      for (const table of ["email", "message", "email_share", "message_share"]) {
        assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id LIKE 'expired-%'`).get()?.n, remaining, table)
        assert.deepEqual(sqlite.prepare(`SELECT id FROM ${table} WHERE id IN ('active', 'permanent') ORDER BY id`).all().map(row => row.id), ["active", "permanent"], table)
      }
    }
    const previousQueries = query.mock.callCount()
    await cleanup.scheduled({} as ScheduledEvent, { DB: d1 })
    assert.equal(query.mock.callCount() - previousQueries, 4)
    assert.deepEqual(info.mock.calls.at(-2)?.arguments[1], { deleted: 0, batches: 1, backlogMayRemain: false })
  })
}

test("cleanup stops at each resource budget even if every batch remains full", async t => {
  const info = t.mock.method(console, "info", () => {})
  const warning = t.mock.method(console, "warn", () => {})
  const queriesByTable = new Map<string, number>()
  let queries = 0
  const d1 = {
    prepare: (statement: string) => ({ bind: (_now: number, size: number) => ({ all: async () => {
      queries++
      const table = statement.match(/DELETE FROM (\w+)/)?.[1]
      assert.ok(table)
      const count = (queriesByTable.get(table) ?? 0) + 1
      queriesByTable.set(table, count)
      if (count > CLEANUP_MAX_BATCHES) throw new Error("Cleanup exceeded a resource query budget")
      assert.equal(size, CLEANUP_BATCH_SIZE)
      return { success: true, results: Array.from({ length: size }, (_, index) => ({ id: `${queries}-${index}` })), meta: { changes: 100_000 } }
    } }) }),
  } as unknown as D1Database
  await cleanup.scheduled({} as ScheduledEvent, { DB: d1 })
  assert.equal(queries, CLEANUP_MAX_BATCHES * 4)
  assert.deepEqual(Object.fromEntries(queriesByTable), { email: 10, email_share: 10, message_share: 10, api_keys: 10 })
  assert.equal(warning.mock.callCount(), 4)
  assert.deepEqual(info.mock.calls.at(-2)?.arguments[1], { deleted: budget, batches: CLEANUP_MAX_BATCHES, backlogMayRemain: true })
})

test("cleanup retains successful batches when a later query fails and resumes on the next run", async t => {
  const { sqlite, d1 } = createTestDatabase()
  t.after(() => sqlite.close())
  const now = 1_800_000_000_000
  t.mock.method(Date, "now", () => now)
  const info = t.mock.method(console, "info", () => {})
  const mailbox = sqlite.prepare("INSERT INTO email(id,address,created_at,expires_at) VALUES(?,?,0,?)")
  for (let index = 0; index < 251; index++) mailbox.run(`expired-${index}`, `expired-${index}@example.com`, now)
  mailbox.run("active", "active@example.com", now + 1)
  const prepare = d1.prepare.bind(d1)
  let queries = 0
  const error = new Error("Synthetic second-batch failure")
  const query = t.mock.method(d1, "prepare", (sql: string) => {
    if (++queries === 2) throw error
    return prepare(sql)
  })
  await assert.rejects(cleanup.scheduled({} as ScheduledEvent, { DB: d1 }), error)
  assert.equal(queries, 2)
  assert.equal(info.mock.callCount(), 0)
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM email WHERE expires_at <= ?").get(now)?.n, 151)
  query.mock.restore()
  await cleanup.scheduled({} as ScheduledEvent, { DB: d1 })
  assert.deepEqual(sqlite.prepare("SELECT id FROM email").all().map(row => row.id), ["active"])
})

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
