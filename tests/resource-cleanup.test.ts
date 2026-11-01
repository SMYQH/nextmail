import test, { type TestContext } from "node:test"
import assert from "node:assert/strict"
import cleanup from "../workers/cleanup"
import { createTestDatabase } from "./helpers/database"

const TABLES = ["email_share", "message_share", "api_keys"] as const
const NOW = 1_800_000_000_123
const BATCH_SIZE = 100
const MAX_BATCHES = 10
const BUDGET = BATCH_SIZE * MAX_BATCHES

function fixture(t: TestContext, count: number) {
  const { sqlite, d1 } = createTestDatabase()
  t.after(() => sqlite.close())
  t.mock.method(Date, "now", () => NOW)
  const info = t.mock.method(console, "info", () => {})
  const warn = t.mock.method(console, "warn", () => {})
  sqlite.exec("INSERT INTO user(id) VALUES('owner')")
  sqlite.prepare("INSERT INTO email(id,address,userId,created_at,expires_at) VALUES('email','owner@example.com','owner',0,?)").run(NOW + 60_000)
  sqlite.exec("INSERT INTO message(id,emailId,subject,content,received_at,sent_at) VALUES('message','email','s','c',0,0)")
  const emailShare = sqlite.prepare("INSERT INTO email_share(id,email_id,token,created_at,expires_at) VALUES(?,'email',?,0,?)")
  const messageShare = sqlite.prepare("INSERT INTO message_share(id,message_id,token,created_at,expires_at) VALUES(?,'message',?,0,?)")
  const key = sqlite.prepare("INSERT INTO api_keys(id,user_id,name,key,created_at,expires_at,enabled) VALUES(?,'owner',?,?,0,?,0)")
  const seed = (id: string, milliseconds: number | null, seconds: number | null) => {
    emailShare.run(id, `email-${id}`, milliseconds)
    messageShare.run(id, `message-${id}`, milliseconds)
    key.run(id, id, `local-${id}`, seconds)
  }
  for (let index = 0; index < count; index++) {
    seed(`expired-${index}`, NOW - index, Math.floor(NOW / 1000) - index)
  }
  // The key timestamp is in seconds, not milliseconds; disabled live keys stay intact.
  seed("active", NOW + 1, Math.floor(NOW / 1000) + 1)
  seed("permanent", null, null)
  return { sqlite, d1, info, warn }
}

for (const count of [0, 1, 99, 100, 101, 1001]) {
  test(`cleanup prunes ${count} expired shares and keys with independent bounded budgets`, async t => {
    const { sqlite, d1, info, warn } = fixture(t, count)
    const prepare = t.mock.method(d1, "prepare")
    let remaining = count
    do {
      const queriesBefore = prepare.mock.callCount()
      const warningsBefore = warn.mock.callCount()
      const deleted = Math.min(remaining, BUDGET)
      const batches = Math.min(Math.floor(remaining / BATCH_SIZE) + 1, MAX_BATCHES)
      await cleanup.scheduled({} as ScheduledEvent, { DB: d1 })
      remaining -= deleted
      assert.equal(prepare.mock.callCount() - queriesBefore, 1 + 3 * batches)
      assert.equal(warn.mock.callCount() - warningsBefore, deleted === BUDGET ? 3 : 0)
      const expected = { deleted, batches, backlogMayRemain: deleted === BUDGET }
      assert.deepEqual(info.mock.calls.at(-1)?.arguments[1], {
        emailShares: expected, messageShares: expected, apiKeys: expected,
      })
      for (const table of TABLES) {
        assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id LIKE 'expired-%'`).get()?.n, remaining, table)
        assert.deepEqual(sqlite.prepare(`SELECT id FROM ${table} WHERE id NOT LIKE 'expired-%' ORDER BY id`).all().map(row => row.id), ["active", "permanent"], table)
      }
      assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM email").get()?.n, 1)
      assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM message").get()?.n, 1)
    } while (remaining > 0)
    await cleanup.scheduled({} as ScheduledEvent, { DB: d1 })
    for (const table of TABLES) assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n, 2)
  })
}

test("resource cleanup preserves completed batches after a failure and resumes next invocation", async t => {
  const { sqlite, d1, info } = fixture(t, 101)
  const prepare = d1.prepare.bind(d1)
  let shareQueries = 0
  const failure = new Error("Synthetic share cleanup failure")
  const query = t.mock.method(d1, "prepare", (statement: string) => {
    if (statement.includes("DELETE FROM email_share") && ++shareQueries === 2) throw failure
    return prepare(statement)
  })
  await assert.rejects(cleanup.scheduled({} as ScheduledEvent, { DB: d1 }), failure)
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM email_share WHERE id LIKE 'expired-%'").get()?.n, 1)
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM message_share WHERE id LIKE 'expired-%'").get()?.n, 101)
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE id LIKE 'expired-%'").get()?.n, 101)
  assert.equal(info.mock.callCount(), 1, "auxiliary cleanup must not report completion after failure")
  query.mock.restore()
  await cleanup.scheduled({} as ScheduledEvent, { DB: d1 })
  for (const table of TABLES) assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n, 2)
})
