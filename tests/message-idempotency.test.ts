import test, { type TestContext } from "node:test"
import assert from "node:assert/strict"
import emailReceiver from "../workers/email-receiver"
import { createTestDatabase } from "./helpers/database"
import { buildDeliveryKey, digestRawMessage } from "../app/lib/delivery-key"
import type { Env } from "../types"

// The worker defers webhook delivery with the execution context, so the tests hand it
// a context and await the deferred task before asserting on the delivery.
const deferredTasks: Promise<unknown>[] = []
const executionContext = {
  waitUntil(task: Promise<unknown>) {
    deferredTasks.push(task)
  },
  passThroughOnException() {},
} as unknown as ExecutionContext

const worker = {
  async email(message: ForwardableEmailMessage, env: Env) {
    deferredTasks.length = 0
    await emailReceiver.email(message, env, executionContext)
    await Promise.all(deferredTasks)
  },
}

function createMessage(recipient: string, content: string, rejections: string[], messageId?: string) {
  const headers = [
    "From: synthetic-sender@example.test",
    `To: ${recipient}`,
    "Subject: private-subject",
    ...(messageId ? [`Message-ID: ${messageId}`] : []),
  ]
  const raw = new Response(
    `${headers.join("\r\n")}\r\n\r\n${content}`,
  ).body!
  return {
    from: "synthetic-sender@example.test",
    to: recipient,
    raw,
    setReject: (reason: string) => rejections.push(reason),
  } as unknown as ForwardableEmailMessage
}

function seedMailbox(sqlite: ReturnType<typeof createTestDatabase>["sqlite"]) {
  sqlite.exec("INSERT INTO user(id) VALUES('owner'); INSERT INTO role(id,name) VALUES('emperor','emperor'); INSERT INTO user_role(user_id,role_id) VALUES('owner','emperor')")
  sqlite.prepare("INSERT INTO email(id,address,userId,created_at,expires_at) VALUES('mailbox',?,'owner',0,?)")
    .run("mailbox@example.test", Date.now() + 60_000)
  sqlite.exec("INSERT INTO webhook(id,user_id,url,secret,enabled,created_at,updated_at) VALUES('hook','owner','https://hooks.example.com/event','signing-secret',1,0,0)")
}

test("a redelivered message is stored once and the webhook fires once", async (t: TestContext) => {
  const { sqlite, d1 } = createTestDatabase()
  t.after(() => sqlite.close())
  seedMailbox(sqlite)

  const deliveries: unknown[] = []
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    deliveries.push(JSON.parse(String(init?.body)))
    return new Response(null, { status: 204 })
  })

  const recipient = "mailbox@example.test"
  const rejections: string[] = []
  const messageId = "<ReDelivery-4f21@Example.test>"

  await worker.email(createMessage(recipient, "redelivered-body", rejections, messageId), {
    DB: d1,
    WEBHOOK_ALLOWED_HOSTS: "hooks.example.com",
  } as unknown as Env)
  await worker.email(createMessage(recipient, "redelivered-body", rejections, messageId), {
    DB: d1,
    WEBHOOK_ALLOWED_HOSTS: "hooks.example.com",
  } as unknown as Env)

  assert.deepEqual(rejections, [], "a redelivery must not be rejected")
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM message").get()?.n, 1)
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM message WHERE is_read = 0").get()?.n, 1)
  // The unread count is derived from the stored rows, so it must not double.
  const statistics = sqlite.prepare(
    "SELECT count(*) AS total, sum(case when is_read = 0 then 1 else 0 end) AS unread FROM message",
  ).get() as { total: number; unread: number }
  assert.equal(Number(statistics.total), 1)
  assert.equal(Number(statistics.unread), 1)
  assert.equal(deliveries.length, 1, "the webhook must fire only for the first delivery")
  const stored = sqlite.prepare("SELECT delivery_key AS key FROM message").get() as { key: string }
  assert.equal(stored.key, `message-id:${messageId}:${recipient.toLowerCase()}`)
})

test("a redelivery without a Message-ID is recognised by the raw message digest", async (t: TestContext) => {
  const { sqlite, d1 } = createTestDatabase()
  t.after(() => sqlite.close())
  seedMailbox(sqlite)

  const deliveries: unknown[] = []
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    deliveries.push(JSON.parse(String(init?.body)))
    return new Response(null, { status: 204 })
  })

  const recipient = "mailbox@example.test"
  const rejections: string[] = []
  await worker.email(createMessage(recipient, "digest-body", rejections), {
    DB: d1,
    WEBHOOK_ALLOWED_HOSTS: "hooks.example.com",
  } as unknown as Env)
  await worker.email(createMessage(recipient, "digest-body", rejections), {
    DB: d1,
    WEBHOOK_ALLOWED_HOSTS: "hooks.example.com",
  } as unknown as Env)

  assert.deepEqual(rejections, [])
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM message").get()?.n, 1)
  assert.equal(deliveries.length, 1)
  const stored = sqlite.prepare("SELECT delivery_key AS key FROM message").get() as { key: string }
  assert.match(stored.key, /^raw-digest:[0-9a-f]{64}:mailbox@example\.test$/)
})

test("the same message delivered to two mailboxes is stored twice", async (t: TestContext) => {
  const { sqlite, d1 } = createTestDatabase()
  t.after(() => sqlite.close())
  seedMailbox(sqlite)
  sqlite.prepare("INSERT INTO email(id,address,userId,created_at,expires_at) VALUES('other',?,'owner',0,?)")
    .run("other@example.test", Date.now() + 60_000)

  const deliveries: unknown[] = []
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    deliveries.push(JSON.parse(String(init?.body)))
    return new Response(null, { status: 204 })
  })

  const rejections: string[] = []
  const messageId = "<shared-8a1b@example.test>"
  for (const recipient of ["mailbox@example.test", "other@example.test"]) {
    await worker.email(createMessage(recipient, "shared-body", rejections, messageId), {
      DB: d1,
      WEBHOOK_ALLOWED_HOSTS: "hooks.example.com",
    } as unknown as Env)
  }

  assert.deepEqual(rejections, [])
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM message").get()?.n, 2)
  assert.equal(deliveries.length, 2)
})

test("Message-ID case distinguishes deliveries while recipient case still deduplicates", async (t: TestContext) => {
  const { sqlite, d1 } = createTestDatabase()
  t.after(() => sqlite.close())
  seedMailbox(sqlite)

  const deliveries: unknown[] = []
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    deliveries.push(JSON.parse(String(init?.body)))
    return new Response(null, { status: 204 })
  })

  const rejections: string[] = []
  const recipient = "mailbox@example.test"
  for (const [messageId, content] of [
    ["<CaseID@example.test>", "case-sensitive-first"],
    ["<caseid@example.test>", "case-sensitive-second"],
  ]) {
    await worker.email(createMessage(recipient, content, rejections, messageId), {
      DB: d1,
      WEBHOOK_ALLOWED_HOSTS: "hooks.example.com",
    } as unknown as Env)
  }

  const statistics = sqlite.prepare(
    "SELECT count(*) AS total, sum(case when is_read = 0 then 1 else 0 end) AS unread FROM message",
  ).get() as { total: number; unread: number }
  assert.equal(Number(statistics.total), 2, "Message-ID case variants are separate deliveries")
  assert.equal(Number(statistics.unread), 2)
  assert.equal(deliveries.length, 2, "both distinct deliveries trigger a webhook")

  await worker.email(createMessage("MAILBOX@EXAMPLE.TEST", "recipient-case-redelivery", rejections, "<CaseID@example.test>"), {
    DB: d1,
    WEBHOOK_ALLOWED_HOSTS: "hooks.example.com",
  } as unknown as Env)

  assert.deepEqual(rejections, [])
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM message").get()?.n, 2,
    "recipient case variants of the same Message-ID deduplicate")
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM message WHERE is_read = 0").get()?.n, 2)
  assert.equal(deliveries.length, 2, "a recipient-case redelivery does not trigger a webhook")
})

test("the delivery key falls back to the raw digest and separates recipients", async () => {
  const raw = new TextEncoder().encode("raw bytes")
  const digest = await digestRawMessage(raw)
  assert.match(digest, /^[0-9a-f]{64}$/)

  const withMessageId = await buildDeliveryKey({
    headers: [{ key: "message-id", value: "<AbC@example.test>" }],
    recipient: "Mailbox@Example.test",
    raw,
  })
  assert.equal(withMessageId, "message-id:<AbC@example.test>:mailbox@example.test")

  const withoutMessageId = await buildDeliveryKey({
    headers: [{ key: "subject", value: "no id" }],
    recipient: "Mailbox@Example.test",
    raw,
  })
  assert.equal(withoutMessageId, `raw-digest:${digest}:mailbox@example.test`)

  const otherRecipient = await buildDeliveryKey({
    headers: [{ key: "message-id", value: "<AbC@example.test>" }],
    recipient: "other@example.test",
    raw,
  })
  assert.notEqual(otherRecipient, withMessageId)
})
