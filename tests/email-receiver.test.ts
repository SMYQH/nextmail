import test, { type TestContext } from "node:test"
import assert from "node:assert/strict"
import { DrizzleQueryError } from "drizzle-orm/errors"
import emailReceiver from "../workers/email-receiver"
import { createTestDatabase } from "./helpers/database"
import type { Env } from "../types"

function captureErrors(t: TestContext) {
  const logged: unknown[][] = []
  t.mock.method(console, "error", (...values: Parameters<typeof console.error>) => { logged.push(values) })
  return logged
}

function createMessage(recipient: string, content: string, rejections: string[]) {
  const raw = new Response(
    `From: synthetic-sender@example.test\r\nTo: ${recipient}\r\nSubject: private-subject\r\n\r\n${content}`
  ).body!
  return {
    from: "synthetic-sender@example.test",
    to: recipient,
    raw,
    setReject: (reason: string) => rejections.push(reason),
  } as unknown as ForwardableEmailMessage
}

function assertLogsExclude(logged: unknown[][], secrets: string[]) {
  const logText = JSON.stringify(logged)
  for (const secret of secrets) {
    assert.equal(logText.includes(secret), false, `log output must not contain ${secret}`)
  }
}

test("failed inbound persistence rejects the message and does not log email or database values", async t => {
  const { sqlite, d1 } = createTestDatabase()
  t.after(() => sqlite.close())

  const recipient = "synthetic-recipient-7a21@example.test"
  const content = "synthetic-body-marker-b4e8"
  const sqlSecret = "synthetic-database-value-930c"
  sqlite.prepare("INSERT INTO email(id,address,created_at,expires_at) VALUES('mailbox',?,0,?)")
    .run(recipient, Date.now() + 60_000)

  const originalPrepare = d1.prepare.bind(d1)
  const persistenceError = new DrizzleQueryError(
    "INSERT INTO message VALUES (?, ?, ?)",
    [recipient, content, sqlSecret],
  )
  const failingD1 = {
    prepare(query: string) {
      if (query.toLowerCase().includes('insert into "message"')) {
        throw persistenceError
      }
      return originalPrepare(query)
    },
    batch: d1.batch.bind(d1),
  } as unknown as D1Database

  const logged = captureErrors(t)
  const rejections: string[] = []
  const message = createMessage(recipient, content, rejections)

  await emailReceiver.email(message, { DB: failingD1 } as unknown as Env)

  assert.deepEqual(rejections, ["Message could not be stored"])
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM message").get()?.count, 0)
  assertLogsExclude(logged, [recipient, content, sqlSecret])
})

test("database initialization failures reject the message and log only safe metadata", async t => {
  const recipient = "synthetic-init-recipient-522f@example.test"
  const content = "synthetic-init-body-37cd"
  const secret = "synthetic-init-database-value-8a4d"
  const error = new DrizzleQueryError("SELECT ?", [secret])
  const env = Object.defineProperty({}, "DB", {
    get() { throw error },
  }) as unknown as Env
  const logged = captureErrors(t)
  const rejections: string[] = []

  await emailReceiver.email(createMessage(recipient, content, rejections), env)

  assert.deepEqual(rejections, ["Message could not be stored"])
  assert.match(JSON.stringify(logged), /DrizzleQueryError/)
  assertLogsExclude(logged, [recipient, content, secret])
})

test("webhook lookup failure after persistence keeps the stored message and accepts the email", async t => {
  const { sqlite, d1 } = createTestDatabase()
  t.after(() => sqlite.close())

  const recipient = "synthetic-lookup-recipient-9d14@example.test"
  const content = "synthetic-lookup-body-0e67"
  const secret = "synthetic-webhook-query-value-1f63"
  sqlite.prepare("INSERT INTO user(id) VALUES(?)").run("owner")
  sqlite.prepare("INSERT INTO email(id,address,userId,created_at,expires_at) VALUES('mailbox',?,'owner',0,?)")
    .run(recipient, Date.now() + 60_000)

  const originalPrepare = d1.prepare.bind(d1)
  const lookupError = new DrizzleQueryError('SELECT * FROM "webhook" WHERE user_id = ?', [secret])
  const failingD1 = {
    prepare(query: string) {
      if (query.toLowerCase().includes('from "webhook"')) throw lookupError
      return originalPrepare(query)
    },
    batch: d1.batch.bind(d1),
  } as unknown as D1Database
  const logged = captureErrors(t)
  const rejections: string[] = []

  await emailReceiver.email(createMessage(recipient, content, rejections), { DB: failingD1 } as unknown as Env)

  assert.deepEqual(rejections, [])
  assert.equal(String(sqlite.prepare("SELECT content FROM message").get()?.content).trim(), content)
  assert.match(JSON.stringify(logged), /Post-save webhook handling failed/)
  assertLogsExclude(logged, [recipient, content, secret])
})

test("webhook delivery failure after persistence keeps the stored message and accepts the email", async t => {
  const { sqlite, d1 } = createTestDatabase()
  t.after(() => sqlite.close())

  const recipient = "synthetic-delivery-recipient-20b3@example.test"
  const content = "synthetic-delivery-body-a664"
  const secret = "synthetic-delivery-error-09f1"
  sqlite.prepare("INSERT INTO user(id) VALUES(?)").run("owner")
  sqlite.prepare("INSERT INTO email(id,address,userId,created_at,expires_at) VALUES('mailbox',?,'owner',0,?)")
    .run(recipient, Date.now() + 60_000)
  sqlite.prepare("INSERT INTO webhook(id,user_id,url,secret,enabled,created_at,updated_at) VALUES('hook','owner','https://hooks.example.com/event','signing-secret',1,0,0)").run()

  const logged = captureErrors(t)
  const rejections: string[] = []
  const delivery = t.mock.method(globalThis, "fetch", async () => {
    throw new Error(`${secret}: ${content}`)
  })

  await emailReceiver.email(createMessage(recipient, content, rejections), {
    DB: d1,
    WEBHOOK_ALLOWED_HOSTS: "hooks.example.com",
  } as unknown as Env)

  assert.deepEqual(rejections, [])
  assert.equal(String(sqlite.prepare("SELECT content FROM message").get()?.content).trim(), content)
  assert.equal(delivery.mock.callCount(), 3)
  assert.match(JSON.stringify(logged), /Post-save webhook handling failed/)
  assertLogsExclude(logged, [recipient, content, secret])
})
