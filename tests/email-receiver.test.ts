import test, { type TestContext } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { DrizzleQueryError } from "drizzle-orm/errors"
import emailReceiver from "../workers/email-receiver"
import { createTestDatabase } from "./helpers/database"
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

function captureErrors(t: TestContext) {
  const logged: unknown[][] = []
  t.mock.method(console, "error", (...values: Parameters<typeof console.error>) => { logged.push(values) })
  return logged
}

function rawBody(recipient: string, content: string, messageId?: string) {
  const headers = [
    "From: synthetic-sender@example.test",
    `To: ${recipient}`,
    "Subject: private-subject",
    ...(messageId ? [`Message-ID: ${messageId}`] : []),
  ]
  return `${headers.join("\r\n")}\r\n\r\n${content}`
}

function createMessage(recipient: string, content: string, rejections: string[], messageId?: string) {
  const raw = new Response(rawBody(recipient, content, messageId)).body!
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

  await worker.email(message, { DB: failingD1 } as unknown as Env)

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

  await worker.email(createMessage(recipient, content, rejections), env)

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

  await worker.email(createMessage(recipient, content, rejections), { DB: failingD1 } as unknown as Env)

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

  await worker.email(createMessage(recipient, content, rejections), {
    DB: d1,
    WEBHOOK_ALLOWED_HOSTS: "hooks.example.com",
  } as unknown as Env)

  assert.deepEqual(rejections, [])
  assert.equal(String(sqlite.prepare("SELECT content FROM message").get()?.content).trim(), content)
  assert.equal(delivery.mock.callCount(), 3)
  assert.match(JSON.stringify(logged), /Post-save webhook handling failed/)
  assertLogsExclude(logged, [recipient, content, secret])
})

test("webhook delivery is deferred so mail acceptance does not wait for a slow endpoint", async t => {
  const { sqlite, d1 } = createTestDatabase()
  t.after(() => sqlite.close())

  const recipient = "synthetic-deferred-recipient-4c2a@example.test"
  const content = "synthetic-deferred-body-8b71"
  sqlite.prepare("INSERT INTO user(id) VALUES(?)").run("owner")
  sqlite.prepare("INSERT INTO email(id,address,userId,created_at,expires_at) VALUES('mailbox',?,'owner',0,?)")
    .run(recipient, Date.now() + 60_000)
  sqlite.prepare("INSERT INTO webhook(id,user_id,url,secret,enabled,created_at,updated_at) VALUES('hook','owner','https://hooks.example.com/event','signing-secret',1,0,0)").run()

  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let attempts = 0
  let completed = 0
  const delivery = t.mock.method(globalThis, "fetch", async () => {
    attempts += 1
    await gate
    completed += 1
    return new Response(null, { status: 204 })
  })

  const rejections: string[] = []
  const tasks: Promise<unknown>[] = []
  const context = {
    waitUntil(task: Promise<unknown>) { tasks.push(task) },
    passThroughOnException() {},
  } as unknown as ExecutionContext

  await emailReceiver.email(createMessage(recipient, content, rejections), {
    DB: d1,
    WEBHOOK_ALLOWED_HOSTS: "hooks.example.com",
  } as unknown as Env, context)

  // The mail was accepted and stored while the endpoint is still pending.
  assert.deepEqual(rejections, [])
  assert.equal(String(sqlite.prepare("SELECT content FROM message").get()?.content).trim(), content)
  assert.equal(tasks.length, 1, "the delivery must be deferred to the execution context")
  assert.equal(completed, 0, "the endpoint must still be pending when the mail is accepted")

  release()
  await Promise.all(tasks)

  assert.equal(delivery.mock.callCount(), 1, "the delivery attempt count is unchanged")
  assert.equal(completed, 1)
  assert.deepEqual(rejections, [])
  assert.equal(String(sqlite.prepare("SELECT content FROM message").get()?.content).trim(), content)
})

test("Catch-all stores the original recipient and visible sender without creating recipient mailboxes", async t => {
  const { sqlite, d1 } = createTestDatabase()
  t.after(() => sqlite.close())
  sqlite.exec("INSERT INTO user(id) VALUES('owner'); INSERT INTO role(id,name) VALUES('emperor','emperor'); INSERT INTO user_role(user_id,role_id) VALUES('owner','emperor')")
  sqlite.prepare("INSERT INTO email(id,address,userId,created_at,expires_at) VALUES('catch','catch@example.test','owner',0,?)")
    .run(new Date('9999-01-01').getTime())
  sqlite.exec("INSERT INTO webhook(id,user_id,url,secret,enabled,created_at,updated_at) VALUES('hook','owner','https://hooks.example.com/event','signing-secret',1,0,0)")
  const deliveries: { toAddress: string; fromAddress: string }[] = []
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    deliveries.push(JSON.parse(String(init?.body)))
    return new Response(null, { status: 204 })
  })
  const recipient = 'Unknown.Tag@EXAMPLE.test'
  const rejected: string[] = []
  const message = { ...createMessage(recipient, 'private-content', rejected), from: 'bounce@send.example.test' } as ForwardableEmailMessage
  await worker.email(message, {
    DB: d1, WEBHOOK_ALLOWED_HOSTS: 'hooks.example.com',
    SITE_CONFIG: { get: async (key: string) => key === 'EMAIL_DOMAINS' ? 'example.test' : JSON.stringify({
      'example.test': { address: 'catch@example.test', enabled: true, showAlways: true },
    }) },
  } as unknown as Env)
  assert.deepEqual(rejected, [])
  const stored = sqlite.prepare('SELECT emailId, from_address, to_address, is_read FROM message').get()
  assert.equal(stored?.emailId, 'catch')
  assert.equal(stored?.from_address, 'synthetic-sender@example.test')
  assert.equal(stored?.to_address, recipient)
  assert.equal(stored?.is_read, 0)
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM email').get()?.n, 1)
  assert.equal(deliveries.length, 1)
  assert.equal(deliveries[0].toAddress, recipient)
  assert.equal(deliveries[0].fromAddress, 'synthetic-sender@example.test')
})

test("Catch-all drops unknown mail when disabled, malformed, removed, or owned by a non-emperor", async t => {
  for (const scenario of ['disabled', 'malformed', 'removed', 'wrong-owner']) {
    const { sqlite, d1 } = createTestDatabase()
    t.after(() => sqlite.close())
    sqlite.exec("INSERT INTO user(id) VALUES('owner'); INSERT INTO role(id,name) VALUES('duke','duke'); INSERT INTO user_role(user_id,role_id) VALUES('owner','duke')")
    sqlite.prepare("INSERT INTO email(id,address,userId,created_at,expires_at) VALUES('catch','catch@example.test','owner',0,?)").run(Date.now() + 60_000)
    const rejected: string[] = []
    await worker.email(createMessage('unknown@example.test', 'body', rejected), {
      DB: d1,
      SITE_CONFIG: { get: async (key: string) => key === 'EMAIL_DOMAINS'
        ? scenario === 'removed' ? 'other.test' : 'example.test'
        : scenario === 'malformed' ? 'invalid-json' : JSON.stringify({
          'example.test': { address: 'catch@example.test', enabled: scenario !== 'disabled' },
        }) },
    } as unknown as Env)
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM message').get()?.n, 0, scenario)
    assert.deepEqual(rejected, [], scenario)
  }
})

test("a legacy rename committing during the receiver lookup cannot split routing snapshots", async t => {
  const { sqlite, d1 } = createTestDatabase()
  t.after(() => sqlite.close())
  sqlite.exec("INSERT INTO user(id) VALUES('owner'); INSERT INTO role(id,name) VALUES('emperor','emperor'); INSERT INTO user_role(user_id,role_id) VALUES('owner','emperor')")
  sqlite.prepare("INSERT INTO email(id,address,userId,created_at,expires_at) VALUES('catch','old@example.test','owner',0,?)")
    .run(new Date('9999-01-01').getTime())
  const prepare = d1.prepare.bind(d1)
  let renamed = false
  t.mock.method(d1, "prepare", (query: string) => {
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values))
        if (property === "raw") return async () => {
          const rows = await target.raw()
          if (!renamed && query.includes('"catch_all_mailbox"')) {
            renamed = true
            sqlite.exec("BEGIN; UPDATE email SET address='new@example.test' WHERE id='catch'; INSERT INTO catch_all_mailbox(domain,email_id) VALUES('example.test','catch'); COMMIT")
          }
          return rows
        }
        return Reflect.get(target, property)
      },
    })
    return wrap(prepare(query))
  })
  const rejected: string[] = []
  await worker.email(createMessage('unknown@example.test', 'body', rejected), {
    DB: d1,
    SITE_CONFIG: { get: async (key: string) => key === 'EMAIL_DOMAINS' ? 'example.test' : JSON.stringify({
      'example.test': { address: 'old@example.test', enabled: true, showAlways: true },
    }) },
  } as unknown as Env)
  assert.equal(renamed, true)
  assert.deepEqual(rejected, [])
  assert.equal(sqlite.prepare("SELECT emailId FROM message").get()?.emailId, 'catch')
})

test("an expired exact recipient is never rerouted through Catch-all", async t => {
  const { sqlite, d1 } = createTestDatabase()
  t.after(() => sqlite.close())
  sqlite.exec("INSERT INTO email(id,address,created_at,expires_at) VALUES('expired','expired@example.test',0,1)")
  let configReads = 0
  const rejected: string[] = []
  await worker.email(createMessage('expired@example.test', 'body', rejected), {
    DB: d1, SITE_CONFIG: { get: async () => { configReads++; throw new Error('must not read Catch-all') } },
  } as unknown as Env)
  assert.equal(configReads, 0)
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM message').get()?.n, 0)
  assert.deepEqual(rejected, [])
})

test("Catch-all infrastructure lookup failures reject instead of silently dropping mail", async t => {
  for (const failure of ["CATCHALL_EMAIL", "EMAIL_DOMAINS", "owner-query"]) {
    await t.test(failure, async t => {
      const { sqlite, d1 } = createTestDatabase()
      t.after(() => sqlite.close())
      const secret = "private-lookup-value"
      const originalPrepare = d1.prepare.bind(d1)
      const failingD1 = {
        prepare(query: string) {
          if (failure === "owner-query" && query.toLowerCase().includes('inner join "user_role"')) {
            throw new DrizzleQueryError(query, [secret])
          }
          return originalPrepare(query)
        },
        batch: d1.batch.bind(d1),
      }
      const logged = captureErrors(t)
      const rejected: string[] = []
      const recipient = "unknown@example.test"
      await worker.email(createMessage(recipient, "private-body", rejected), {
        DB: failingD1,
        SITE_CONFIG: {
          get: async (key: string) => {
            if (key === failure) throw new Error(secret)
            return key === "EMAIL_DOMAINS" ? "example.test" : JSON.stringify({
              "example.test": { address: "catch@example.test", enabled: true, showAlways: true },
            })
          },
        },
      } as unknown as Env)
      assert.deepEqual(rejected, ["Message could not be stored"])
      assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM message").get()?.count, 0)
      assertLogsExclude(logged, [secret, recipient, "private-body"])
    })
  }
})

test("the raw message is hashed only when it carries no Message-ID", async t => {
  const { sqlite, d1 } = createTestDatabase()
  t.after(() => sqlite.close())
  sqlite.exec("INSERT INTO user(id) VALUES('owner'); INSERT INTO role(id,name) VALUES('emperor','emperor'); INSERT INTO user_role(user_id,role_id) VALUES('owner','emperor')")
  sqlite.prepare("INSERT INTO email(id,address,userId,created_at,expires_at) VALUES('mailbox',?,'owner',0,?)")
    .run("mailbox@example.test", Date.now() + 60_000)
  sqlite.exec("INSERT INTO webhook(id,user_id,url,secret,enabled,created_at,updated_at) VALUES('hook','owner','https://hooks.example.com/event','signing-secret',1,0,0)")

  const deliveries: unknown[] = []
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    deliveries.push(JSON.parse(String(init?.body)))
    return new Response(null, { status: 204 })
  })

  // Every SHA-256 computation of the worker passes through this digest, so the
  // call count shows whether the raw message was hashed at all.
  const subtle = globalThis.crypto.subtle
  const originalDigest = subtle.digest.bind(subtle)
  const hashed: BufferSource[] = []
  const digest = t.mock.method(subtle, "digest", async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
    hashed.push(data)
    return originalDigest(algorithm, data)
  })

  const recipient = "mailbox@example.test"
  const rejections: string[] = []
  const messageId = "<Lazy-Digest-7c3f@Example.test>"
  await worker.email(createMessage(recipient, "identified-body", rejections, messageId), {
    DB: d1,
    WEBHOOK_ALLOWED_HOSTS: "hooks.example.com",
  } as unknown as Env)

  assert.equal(digest.mock.callCount(), 0, "a message with a Message-ID must not be hashed")
  assert.deepEqual(rejections, [])
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM message").get()?.n, 1)
  assert.equal(deliveries.length, 1)
  const identified = sqlite.prepare("SELECT delivery_key AS key FROM message").get() as { key: string }
  assert.equal(identified.key, `message-id:${messageId}:${recipient.toLowerCase()}`)

  const body = rawBody(recipient, "unidentified-body")
  await worker.email(createMessage(recipient, "unidentified-body", rejections), {
    DB: d1,
    WEBHOOK_ALLOWED_HOSTS: "hooks.example.com",
  } as unknown as Env)

  assert.equal(digest.mock.callCount(), 1, "a message without a Message-ID must be hashed exactly once")
  assert.equal(hashed.length, 1)
  // The digest hashes the buffer that is already held, so the view over the raw
  // bytes is passed on instead of a second copy of it.
  assert.equal(hashed[0] instanceof Uint8Array, true, "the digest must hash the buffer that is already held")
  assert.equal((hashed[0] as Uint8Array).byteLength, new TextEncoder().encode(body).byteLength)
  assert.deepEqual(rejections, [])
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM message").get()?.n, 2)
  assert.equal(deliveries.length, 2)
  const stored = sqlite.prepare("SELECT delivery_key AS key FROM message WHERE delivery_key LIKE 'raw-digest:%'").get() as { key: string }
  const expectedDigest = createHash("sha256").update(body, "utf8").digest("hex")
  assert.equal(stored.key, `raw-digest:${expectedDigest}:${recipient.toLowerCase()}`)
})
