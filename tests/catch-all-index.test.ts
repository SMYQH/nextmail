import test from "node:test"
import assert from "node:assert/strict"
import emailReceiver from "../workers/email-receiver"
import { createTestDatabase } from "./helpers/database"
import type { Env } from "../types"

const deferredTasks: Promise<unknown>[] = []
const executionContext = {
  waitUntil(task: Promise<unknown>) {
    deferredTasks.push(task)
  },
  passThroughOnException() {},
} as unknown as ExecutionContext

function createMessage(recipient: string, rejections: string[]) {
  const raw = new Response(
    `From: synthetic-sender@example.test\r\nTo: ${recipient}\r\nSubject: private-subject\r\n\r\nbody`
  ).body!
  return {
    from: "synthetic-sender@example.test",
    to: recipient,
    raw,
    setReject: (reason: string) => rejections.push(reason),
  } as unknown as ForwardableEmailMessage
}

test("the Catch-all lookup uses indexes instead of scanning the email table", async () => {
  const { sqlite, d1 } = createTestDatabase()
  try {
    sqlite.exec("INSERT INTO user(id) VALUES('owner'); INSERT INTO role(id,name) VALUES('emperor','emperor'); INSERT INTO user_role(user_id,role_id) VALUES('owner','emperor')")
    const insert = sqlite.prepare("INSERT INTO email(id,address,userId,created_at,expires_at) VALUES(?,?,?,0,?)")
    // A large mailbox table makes a scan visible in the query plan.
    for (let index = 0; index < 200; index++) insert.run(`mailbox-${index}`, `mailbox-${index}@example.test`, "owner", Date.now() + 60_000)
    insert.run("catch", "catch@example.test", "owner", Date.now() + 60_000)

    // Capture the statements the worker actually issues.
    const prepared: { sql: string; params: unknown[] }[] = []
    const originalPrepare = d1.prepare.bind(d1)
    const capturingD1 = {
      prepare(sql: string) {
        const statement = originalPrepare(sql)
        const record = { sql, params: [] as unknown[] }
        prepared.push(record)
        return {
          bind: (...values: unknown[]) => {
            record.params = values
            return statement.bind(...values)
          },
        }
      },
      batch: d1.batch.bind(d1),
    } as unknown as D1Database

    const rejected: string[] = []
    deferredTasks.length = 0
    await emailReceiver.email(createMessage("unknown@example.test", rejected), {
      DB: capturingD1,
      SITE_CONFIG: { get: async (key: string) => key === "EMAIL_DOMAINS" ? "example.test" : JSON.stringify({
        "example.test": { address: "catch@example.test", enabled: true, showAlways: true },
      }) },
    } as unknown as Env, executionContext)
    await Promise.all(deferredTasks)

    assert.deepEqual(rejected, [])
    assert.equal(sqlite.prepare("SELECT emailId FROM message").get()?.emailId, "catch")

    // The Catch-all lookup is the statement that resolves the target mailbox.
    const lookup = prepared.find(entry => entry.sql.includes("catch_all_mailbox"))
    assert.ok(lookup, `the Catch-all lookup must be issued: ${prepared.map(entry => entry.sql).join(" | ")}`)

    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${lookup.sql}`).all(...lookup.params as never[]) as { detail: string }[]
    const details = plan.map(row => row.detail)

    assert.equal(details.some(detail => /SCAN email\b/.test(detail)), false, `the email table must not be scanned: ${details.join(" | ")}`)
    assert.equal(details.some(detail => detail.includes("email_address_lower_idx")), true, `the lower(address) index must be used: ${details.join(" | ")}`)
    assert.equal(details.some(detail => detail.includes("catch_all_mailbox")), true, `the catch-all registry lookup must be indexed: ${details.join(" | ")}`)
  } finally {
    sqlite.close()
  }
})
