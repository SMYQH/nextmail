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
  await emailReceiver.email(message, {
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
    await emailReceiver.email(createMessage('unknown@example.test', 'body', rejected), {
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
  await emailReceiver.email(createMessage('unknown@example.test', 'body', rejected), {
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
  await emailReceiver.email(createMessage('expired@example.test', 'body', rejected), {
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
      await emailReceiver.email(createMessage(recipient, "private-body", rejected), {
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
