import test from "node:test"
import assert from "node:assert/strict"
import type { DeploymentQuery } from "../scripts/deploy/admin-config"
import { applyAdminUsers, readAdminUsers, type AdminUsersPlan } from "../scripts/deploy/admin-users"
import { comparePassword, hashPassword } from "../app/lib/password"
import { createTestDatabase } from "./helpers/database"

const DOMAINS = ["mail.example.com", "alt.example.com"]
const WEBHOOK_HOSTS = "hooks.example.net"

function makeQuery(sqlite: ReturnType<typeof createTestDatabase>["sqlite"], writes: string[] = []): DeploymentQuery {
  return async (sql, params = []) => {
    if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)) writes.push(sql)
    const statement = sqlite.prepare(sql)
    if (/\bRETURNING\b/i.test(sql) || /^\s*(SELECT|PRAGMA)\b/i.test(sql)) {
      return statement.all(...params) as Record<string, unknown>[]
    }
    statement.run(...params)
    return []
  }
}

async function seededUser(
  sqlite: ReturnType<typeof createTestDatabase>["sqlite"],
  id: string,
  username: string,
  roleName?: string,
  password?: string,
) {
  sqlite.prepare("INSERT INTO user (id, username, password, name) VALUES (?, ?, ?, ?)")
    .run(id, username, password ?? null, username)
  if (roleName) {
    sqlite.prepare("INSERT INTO role (id, name, description) VALUES (?, ?, ?)")
      .run(`role-${roleName}`, roleName, roleName)
    sqlite.prepare("INSERT INTO user_role (user_id, role_id) VALUES (?, ?)")
      .run(id, `role-${roleName}`)
  }
}

const initialPlan = (): AdminUsersPlan => [{
  username: "deploy_admin",
  password: "InitialAdminPassword!",
  name: "Deploy Admin",
  role: "duke",
  allowedDomains: [" MAIL.EXAMPLE.COM ", "mail.example.com"],
  apiKeys: [{
    name: "Automation",
    key: "mk_deploy_private_key",
    enabled: false,
    expiresAt: "2032-01-02T03:04:05.000Z",
  }],
  webhook: {
    url: "https://hooks.example.net/nextmail",
    secret: "deploy-private-webhook-secret",
    enabled: true,
  },
}]

test("ADMIN_USERS is optional and malformed plans never reveal configured credentials", () => {
  assert.equal(readAdminUsers({}), undefined)
  assert.equal(readAdminUsers({ ADMIN_USERS: "   " }), undefined)
  assert.deepEqual(readAdminUsers({ ADMIN_USERS: "[]" }), [])

  const secrets = ["private-password", "private-api-key", "private-webhook-secret"]
  for (const value of [
    "{",
    "null",
    "{}",
    JSON.stringify([{ username: "not valid", password: secrets[0] }]),
    JSON.stringify([{ username: "valid_user", apiKeys: [{ name: "key", key: secrets[1], expiresAt: null }] }]),
  ]) {
    assert.throws(() => readAdminUsers({ ADMIN_USERS: value }), error => {
      const message = error instanceof Error ? error.message : String(error)
      assert.match(message, /ADMIN_USERS/)
      for (const secret of secrets) assert.equal(message.includes(secret), false)
      return true
    })
  }

  const tooManyUsers = Array.from({ length: 101 }, (_, index) => ({ username: `admin_${index}` }))
  assert.throws(() => readAdminUsers({ ADMIN_USERS: JSON.stringify(tooManyUsers) }), /ADMIN_USERS/)
  const tooManyKeys = [{
    username: "bounded_admin",
    apiKeys: Array.from({ length: 501 }, (_, index) => ({ name: `key-${index}` })),
  }]
  assert.throws(() => readAdminUsers({ ADMIN_USERS: JSON.stringify(tooManyKeys) }), /ADMIN_USERS/)
})

test("ADMIN_USERS creates local identities and owner-scoped settings idempotently", async t => {
  const { sqlite } = createTestDatabase()
  t.after(() => sqlite.close())
  const initialWrites: string[] = []
  const query = makeQuery(sqlite, initialWrites)
  const plan = initialPlan()

  await applyAdminUsers(plan, query, DOMAINS, WEBHOOK_HOSTS)
  for (const statement of initialWrites) {
    assert.equal(statement.includes("InitialAdminPassword!"), false)
    assert.equal(statement.includes("mk_deploy_private_key"), false)
    assert.equal(statement.includes("deploy-private-webhook-secret"), false)
  }

  const user = sqlite.prepare("SELECT id, username, password, name FROM user WHERE username = ?").get("deploy_admin")
  assert.ok(user)
  assert.equal(user.name, "Deploy Admin")
  assert.notEqual(user.password, "InitialAdminPassword!")
  assert.equal(await comparePassword("InitialAdminPassword!", String(user.password)), true)
  assert.equal(sqlite.prepare("SELECT r.name FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE ur.user_id = ?").get(user.id)?.name, "duke")

  const domainAccess = sqlite.prepare("SELECT domains FROM user_email_domain_access WHERE user_id = ?").get(user.id)
  assert.equal(domainAccess?.domains, '["mail.example.com"]')
  const apiKey = sqlite.prepare("SELECT user_id, name, key, enabled, expires_at FROM api_keys WHERE name = ?").get("Automation")
  assert.deepEqual({ ...apiKey }, {
    user_id: user.id,
    name: "Automation",
    key: "mk_deploy_private_key",
    enabled: 0,
    expires_at: Math.floor(Date.parse("2032-01-02T03:04:05.000Z") / 1000),
  })
  const webhook = sqlite.prepare("SELECT user_id, url, secret, enabled FROM webhook WHERE user_id = ?").get(user.id)
  assert.deepEqual({ ...webhook }, {
    user_id: user.id,
    url: "https://hooks.example.net/nextmail",
    secret: "deploy-private-webhook-secret",
    enabled: 1,
  })

  const countsBefore = [
    sqlite.prepare("SELECT COUNT(*) AS count FROM user").get()?.count,
    sqlite.prepare("SELECT COUNT(*) AS count FROM user_role").get()?.count,
    sqlite.prepare("SELECT COUNT(*) AS count FROM api_keys").get()?.count,
    sqlite.prepare("SELECT COUNT(*) AS count FROM webhook").get()?.count,
  ]
  const passwordBefore = user.password
  const webhookTimestamp = sqlite.prepare("SELECT updated_at FROM webhook WHERE user_id = ?").get(user.id)?.updated_at
  const writes: string[] = []
  await applyAdminUsers(plan, makeQuery(sqlite, writes), DOMAINS, WEBHOOK_HOSTS)
  assert.deepEqual(writes, [])
  assert.deepEqual([
    sqlite.prepare("SELECT COUNT(*) AS count FROM user").get()?.count,
    sqlite.prepare("SELECT COUNT(*) AS count FROM user_role").get()?.count,
    sqlite.prepare("SELECT COUNT(*) AS count FROM api_keys").get()?.count,
    sqlite.prepare("SELECT COUNT(*) AS count FROM webhook").get()?.count,
  ], countsBefore)
  assert.equal(sqlite.prepare("SELECT password FROM user WHERE id = ?").get(user.id)?.password, passwordBefore)
  assert.equal(sqlite.prepare("SELECT updated_at FROM webhook WHERE user_id = ?").get(user.id)?.updated_at, webhookTimestamp)
})

test("ADMIN_USERS blank fields preserve selected values and domain overrides follow browser semantics", async t => {
  const { sqlite } = createTestDatabase()
  t.after(() => sqlite.close())
  const query = makeQuery(sqlite)
  await applyAdminUsers(initialPlan(), query, DOMAINS, WEBHOOK_HOSTS)
  const user = sqlite.prepare("SELECT id, password FROM user WHERE username = ?").get("deploy_admin")
  assert.ok(user)
  const expiryBefore = sqlite.prepare("SELECT expires_at FROM api_keys WHERE user_id = ?").get(user.id)?.expires_at

  const blankPreservePlan = readAdminUsers({ ADMIN_USERS: JSON.stringify([{
    username: "deploy_admin",
    password: "   ",
    name: " ",
    role: " ",
    apiKeys: [{ name: "Automation", key: "  ", enabled: true, expiresAt: "   " }],
    webhook: { url: " ", secret: " ", enabled: false },
  }]) })
  assert.ok(blankPreservePlan)
  await applyAdminUsers(blankPreservePlan, query, DOMAINS, WEBHOOK_HOSTS)

  assert.equal(sqlite.prepare("SELECT password FROM user WHERE id = ?").get(user.id)?.password, user.password)
  assert.equal(sqlite.prepare("SELECT name FROM user WHERE id = ?").get(user.id)?.name, "Deploy Admin")
  assert.equal(sqlite.prepare("SELECT r.name FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE ur.user_id = ?").get(user.id)?.name, "duke")
  assert.equal(sqlite.prepare("SELECT domains FROM user_email_domain_access WHERE user_id = ?").get(user.id)?.domains, '["mail.example.com"]')
  assert.deepEqual({ ...sqlite.prepare("SELECT key, enabled, expires_at FROM api_keys WHERE user_id = ?").get(user.id) }, {
    key: "mk_deploy_private_key",
    enabled: 1,
    expires_at: expiryBefore,
  })
  assert.deepEqual({ ...sqlite.prepare("SELECT url, secret, enabled FROM webhook WHERE user_id = ?").get(user.id) }, {
    url: "https://hooks.example.net/nextmail",
    secret: "deploy-private-webhook-secret",
    enabled: 0,
  })

  await applyAdminUsers([{ username: "deploy_admin", allowedDomains: [] }], query, DOMAINS, WEBHOOK_HOSTS)
  assert.equal(sqlite.prepare("SELECT domains FROM user_email_domain_access WHERE user_id = ?").get(user.id)?.domains, "[]")
  await applyAdminUsers([{ username: "deploy_admin", allowedDomains: null }], query, DOMAINS, WEBHOOK_HOSTS)
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM user_email_domain_access WHERE user_id = ?").get(user.id)?.count, 0)
})

test("ADMIN_USERS rejects OAuth claims and cross-owner API-key reuse before any write", async t => {
  const { sqlite } = createTestDatabase()
  t.after(() => sqlite.close())
  await seededUser(sqlite, "oauth-user", "oauth_admin")
  sqlite.prepare("INSERT INTO account (userId, type, provider, providerAccountId) VALUES (?, ?, ?, ?)")
    .run("oauth-user", "oauth", "github", "oauth-admin")
  await seededUser(sqlite, "other-user", "other_admin", "duke", "existing-password-hash")
  sqlite.prepare("INSERT INTO api_keys (id, user_id, name, key, enabled) VALUES (?, ?, ?, ?, ?)")
    .run("other-key", "other-user", "Automation", "mk_foreign_private_key", 1)

  const writes: string[] = []
  const query = makeQuery(sqlite, writes)
  await assert.rejects(
    applyAdminUsers([{ username: "oauth_admin", password: "NewPassword!123", role: "duke" }], query, DOMAINS, WEBHOOK_HOSTS),
    /cannot claim an existing OAuth or unowned account/,
  )
  await assert.rejects(
    applyAdminUsers([{
      username: "new_admin",
      password: "NewPassword!123",
      role: "duke",
      apiKeys: [{ name: "Automation", key: "  mk_foreign_private_key \t" }],
    }], query, DOMAINS, WEBHOOK_HOSTS),
    error => {
      const message = error instanceof Error ? error.message : String(error)
      assert.match(message, /ownership conflicts/)
      assert.equal(message.includes("mk_foreign_private_key"), false)
      return true
    },
  )
  assert.deepEqual(writes, [])
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM user WHERE username = ?").get("new_admin")?.count, 0)
  assert.equal(sqlite.prepare("SELECT user_id FROM api_keys WHERE key = ?").get("mk_foreign_private_key")?.user_id, "other-user")

  await applyAdminUsers([{
    username: "new_admin",
    password: "NewPassword!123",
    role: "duke",
    apiKeys: [{ name: "Automation", key: "  mk_own_private_key \t" }],
  }], query, DOMAINS, WEBHOOK_HOSTS)
  const newUser = sqlite.prepare("SELECT id FROM user WHERE username = ?").get("new_admin")
  assert.ok(newUser)
  const normalizedKey = sqlite.prepare("SELECT key, user_id FROM api_keys WHERE user_id = ? AND name = ?")
    .get(newUser.id, "Automation")
  assert.deepEqual({ ...normalizedKey }, { key: "mk_own_private_key", user_id: newUser.id })
  assert.equal(sqlite.prepare("SELECT user_id FROM api_keys WHERE key = ?").get("mk_foreign_private_key")?.user_id, "other-user")
})

test("new ADMIN_USERS API keys use the normal one-year lifetime and role authority", async t => {
  const { sqlite } = createTestDatabase()
  t.after(() => sqlite.close())
  await applyAdminUsers([{
    username: "key_admin",
    password: "KeyAdminPassword!",
    role: "duke",
    apiKeys: [{ name: "Default expiry", key: "mk_default_expiry_key" }],
  }], makeQuery(sqlite), DOMAINS, WEBHOOK_HOSTS)

  const now = Math.floor(Date.now() / 1000)
  const key = sqlite.prepare(
    `SELECT k.id, k.enabled, k.expires_at, r.name AS role FROM api_keys k
     JOIN user_role ur ON ur.user_id = k.user_id JOIN role r ON r.id = ur.role_id
     WHERE k.key = ?`,
  ).get("mk_default_expiry_key")
  assert.ok(key)
  assert.equal(key.enabled, 1)
  assert.equal(key.role, "duke")
  const expiresAt = Number(key.expires_at)
  assert.ok(Number.isFinite(expiresAt) && expiresAt > now && expiresAt <= now + 365 * 24 * 60 * 60)
  const usable = sqlite.prepare(
    `SELECT k.id FROM api_keys k JOIN user_role ur ON ur.user_id = k.user_id
     JOIN role r ON r.id = ur.role_id WHERE k.key = ? AND k.enabled = 1
     AND k.expires_at > ? AND r.name IN ('emperor', 'duke')`,
  ).get("mk_default_expiry_key", now)
  assert.ok(usable)
})

test("ADMIN_USERS enforces emperor uniqueness, no demotion, API-key authority, and the webhook host allowlist before writes", async t => {
  const { sqlite } = createTestDatabase()
  t.after(() => sqlite.close())
  const password = await hashPassword("OwnerPassword!123")
  await seededUser(sqlite, "emperor-user", "site_owner", "emperor", password)
  sqlite.prepare("INSERT INTO user_email_domain_access (user_id, domains) VALUES (?, ?)")
    .run("emperor-user", '["mail.example.com"]')
  const writes: string[] = []
  const query = makeQuery(sqlite, writes)

  await assert.rejects(
    applyAdminUsers([{ username: "second_owner", password: "NewPassword!123", role: "emperor" }], query, DOMAINS, WEBHOOK_HOSTS),
    /cannot assign a second emperor/,
  )
  await assert.rejects(
    applyAdminUsers([{ username: "site_owner", role: "duke" }], query, DOMAINS, WEBHOOK_HOSTS),
    /cannot demote an emperor/,
  )
  await assert.rejects(
    applyAdminUsers([{ username: "site_owner", allowedDomains: [] }], query, DOMAINS, WEBHOOK_HOSTS),
    /cannot restrict an emperor/,
  )
  await assert.rejects(
    applyAdminUsers([{
      username: "low_role",
      password: "NewPassword!123",
      role: "knight",
      apiKeys: [{ name: "Unauthorized", key: "mk_private_low_role_key" }],
    }], query, DOMAINS, WEBHOOK_HOSTS),
    /role without API key authority/,
  )
  await assert.rejects(
    applyAdminUsers([{
      username: "bad_webhook",
      password: "NewPassword!123",
      role: "duke",
      webhook: { url: "https://not-allowed.example.net/hook", secret: "private-hook-secret" },
    }], query, DOMAINS, WEBHOOK_HOSTS),
    error => {
      const message = error instanceof Error ? error.message : String(error)
      assert.match(message, /webhook/)
      assert.equal(message.includes("not-allowed.example.net"), false)
      assert.equal(message.includes("private-hook-secret"), false)
      return true
    },
  )
  assert.deepEqual(writes, [])
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM user WHERE username IN (?, ?, ?)").get("second_owner", "low_role", "bad_webhook")?.count, 0)

  await applyAdminUsers([{ username: "site_owner", allowedDomains: null }], query, DOMAINS, WEBHOOK_HOSTS)
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM user_email_domain_access WHERE user_id = ?").get("emperor-user")?.count, 0)
  assert.equal(sqlite.prepare("SELECT r.name FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE ur.user_id = ?").get("emperor-user")?.name, "emperor")
})

test("ADMIN_USERS replaces role sets atomically and protects concurrent emperor assignments", async t => {
  const { sqlite } = createTestDatabase()
  t.after(() => sqlite.close())
  await seededUser(sqlite, "multi-role-user", "multi_role_admin", "civilian", "existing-password-hash")
  sqlite.prepare("INSERT INTO role (id, name, description) VALUES (?, ?, ?)")
    .run("role-knight", "knight", "knight")
  sqlite.prepare("INSERT INTO user_role (user_id, role_id) VALUES (?, ?)")
    .run("multi-role-user", "role-knight")

  const writes: string[] = []
  await applyAdminUsers(
    [{ username: "multi_role_admin", role: "duke" }],
    makeQuery(sqlite, writes),
    DOMAINS,
    WEBHOOK_HOSTS,
  )
  assert.deepEqual(
    sqlite.prepare(
      "SELECT r.name FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE ur.user_id = ? ORDER BY r.name",
    ).all("multi-role-user").map(row => row.name),
    ["duke"],
  )
  const roleWrites = writes.filter(sql => /\buser_role\b/i.test(sql))
  assert.equal(roleWrites.length, 1)
  assert.match(roleWrites[0], /^\s*UPDATE OR REPLACE user_role/i)

  await seededUser(sqlite, "concurrent-downgrade", "concurrent_downgrade", undefined, "existing-password-hash")
  sqlite.prepare("INSERT INTO user_role (user_id, role_id) VALUES (?, ?)")
    .run("concurrent-downgrade", "role-civilian")
  sqlite.prepare("INSERT INTO role (id, name, description) VALUES (?, ?, ?)")
    .run("role-emperor", "emperor", "emperor")
  const delegate = makeQuery(sqlite)
  let emperorAddedToDowngradeTarget = false
  const downgradeQuery: DeploymentQuery = async (sql, params = []) => {
    if (!emperorAddedToDowngradeTarget && /^\s*UPDATE OR REPLACE user_role/i.test(sql)) {
      emperorAddedToDowngradeTarget = true
      sqlite.prepare("INSERT INTO user_role (user_id, role_id) VALUES (?, ?)")
        .run("concurrent-downgrade", "role-emperor")
    }
    return delegate(sql, params)
  }
  await assert.rejects(
    applyAdminUsers([{ username: "concurrent_downgrade", role: "duke" }], downgradeQuery, DOMAINS, WEBHOOK_HOSTS),
    /role changed during deployment/,
  )
  assert.equal(emperorAddedToDowngradeTarget, true)
  assert.deepEqual(
    sqlite.prepare(
      "SELECT r.name FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE ur.user_id = ? ORDER BY r.name",
    ).all("concurrent-downgrade").map(row => row.name),
    ["civilian", "emperor"],
  )
  sqlite.prepare("DELETE FROM user_role WHERE user_id = ? AND role_id = ?")
    .run("concurrent-downgrade", "role-emperor")

  await seededUser(sqlite, "emperor-race-target", "emperor_race_target", undefined, "existing-password-hash")
  sqlite.prepare("INSERT INTO user_role (user_id, role_id) VALUES (?, ?)")
    .run("emperor-race-target", "role-civilian")
  await seededUser(sqlite, "emperor-race-winner", "emperor_race_winner")
  const triggerDelegate = makeQuery(sqlite)
  let emperorClaimedByOtherUser = false
  const promotionQuery: DeploymentQuery = async (sql, params = []) => {
    if (!emperorClaimedByOtherUser && /^\s*UPDATE OR REPLACE user_role/i.test(sql)) {
      emperorClaimedByOtherUser = true
      sqlite.prepare("INSERT INTO user_role (user_id, role_id) VALUES (?, ?)")
        .run("emperor-race-winner", "role-emperor")
    }
    return triggerDelegate(sql, params)
  }
  await assert.rejects(
    applyAdminUsers([{ username: "emperor_race_target", role: "emperor" }], promotionQuery, DOMAINS, WEBHOOK_HOSTS),
    /Only one emperor is allowed/,
  )
  assert.equal(emperorClaimedByOtherUser, true)
  assert.deepEqual(
    sqlite.prepare(
      "SELECT r.name FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE ur.user_id = ? ORDER BY r.name",
    ).all("emperor-race-target").map(row => row.name),
    ["civilian"],
  )
  assert.deepEqual(
    sqlite.prepare(
      "SELECT r.name FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE ur.user_id = ? ORDER BY r.name",
    ).all("emperor-race-winner").map(row => row.name),
    ["emperor"],
  )
})

test("ADMIN_USERS requires webhook authority and validates retained URLs when enabling", async t => {
  const { sqlite } = createTestDatabase()
  t.after(() => sqlite.close())
  await seededUser(sqlite, "webhook-user", "webhook_admin", "duke", "existing-password-hash")
  sqlite.prepare("INSERT INTO webhook (id, user_id, url, secret, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("blocked-hook", "webhook-user", "https://blocked.example.net/notify", "synthetic-secret", 1, 1, 1)
  const writes: string[] = []
  const query = makeQuery(sqlite, writes)

  await assert.rejects(
    applyAdminUsers([{ username: "webhook_admin", webhook: { enabled: true } }], query, DOMAINS, WEBHOOK_HOSTS),
    /ADMIN_USERS webhook/,
  )
  assert.deepEqual(writes, [])
  assert.equal(sqlite.prepare("SELECT enabled FROM webhook WHERE id = ?").get("blocked-hook")?.enabled, 1)

  await applyAdminUsers([{ username: "webhook_admin", webhook: { enabled: false } }], query, DOMAINS, WEBHOOK_HOSTS)
  assert.equal(sqlite.prepare("SELECT enabled FROM webhook WHERE id = ?").get("blocked-hook")?.enabled, 0)

  const beforeLowRole = writes.length
  await assert.rejects(
    applyAdminUsers([{
      username: "low_webhook_role",
      password: "NewPassword!123",
      role: "civilian",
      webhook: { url: "https://hooks.example.net/notify" },
    }], query, DOMAINS, WEBHOOK_HOSTS),
    /role without webhook authority/,
  )
  assert.equal(writes.length, beforeLowRole)
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM user WHERE username = ?").get("low_webhook_role")?.count, 0)
})

test("ADMIN_USERS generates a secret when creating a webhook without one", async t => {
  const { sqlite } = createTestDatabase()
  t.after(() => sqlite.close())

  await applyAdminUsers([
    {
      username: "hook_secret_omitted",
      password: "WebhookPassword!123",
      role: "duke",
      webhook: { url: "https://hooks.example.net/omitted" },
    },
    {
      username: "hook_secret_blank",
      password: "WebhookPassword!123",
      role: "duke",
      webhook: { url: "https://hooks.example.net/blank", secret: " \t " },
    },
  ], makeQuery(sqlite), DOMAINS, WEBHOOK_HOSTS)

  const hooks = sqlite.prepare(
    `SELECT u.username, w.secret, w.enabled FROM webhook w
     JOIN user u ON u.id = w.user_id ORDER BY u.username`,
  ).all()
  assert.equal(hooks.length, 2)
  for (const hook of hooks) {
    assert.match(String(hook.secret), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    assert.equal(hook.enabled, 1)
  }
  assert.notEqual(hooks[0].secret, hooks[1].secret)
})
