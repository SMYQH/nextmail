import test from "node:test"
import assert from "node:assert/strict"
import { readAdminDeploymentConfig, applyAdminSiteSettings, applyAdminCatchAllSettings } from "../scripts/deploy/admin-config"
import { createTestDatabase } from "./helpers/database"

function configStore(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  const writes: string[] = []
  return { values, writes, get: async (key: string) => values.get(key) ?? null, put: async (key: string, value: string) => { writes.push(key); values.set(key, value) } }
}

test("fresh deployments seed the receiving domain; blank options preserve browser configuration", async () => {
  const store = configStore()
  await applyAdminSiteSettings(readAdminDeploymentConfig({ EMAIL_DOMAIN: "EXAMPLE.com" }), store)
  assert.equal(store.values.get("EMAIL_DOMAINS"), "example.com")
  store.values.set("EMAIL_DOMAINS", "other.example")
  store.values.set("DEFAULT_ROLE", "knight")
  store.values.set("MAX_EMAILS", "7")
  store.writes.length = 0
  await applyAdminSiteSettings(readAdminDeploymentConfig({ EMAIL_DOMAIN: "example.com", DEFAULT_ROLE: "", MAX_EMAILS: " " }), store)
  assert.deepEqual(store.writes, [])
  assert.equal(store.values.get("EMAIL_DOMAINS"), "other.example")
  assert.equal(store.values.get("DEFAULT_ROLE"), "knight")
  assert.equal(store.values.get("MAX_EMAILS"), "7")
})

test("all website and email service options are persisted in their browser-managed format", async () => {
  const store = configStore()
  await applyAdminSiteSettings(readAdminDeploymentConfig({
    EMAIL_DOMAIN: "example.com", EMAIL_DOMAINS: "EXAMPLE.com,example.net", DEFAULT_ROLE: "duke", MAX_EMAILS: "12",
    ADMIN_CONTACT: "admin@example.com", TURNSTILE_ENABLED: "true", TURNSTILE_SITE_KEY: "synthetic-site",
    TURNSTILE_SECRET_KEY: "synthetic-secret", EMAIL_ROLE_LIMITS: '{"duke":0,"knight":-1}',
    RESEND_CONFIG: '{"EXAMPLE.com":{"enabled":true,"apiKey":"synthetic-resend"},"example.net":{"enabled":false,"apiKey":""}}',
  }), store)
  assert.equal(store.values.get("DEFAULT_ROLE"), "duke")
  assert.equal(store.values.get("MAX_EMAILS"), "12")
  assert.equal(store.values.get("EMAIL_DOMAINS"), "example.com,example.net")
  assert.equal(store.values.get("TURNSTILE_SECRET_KEY"), "synthetic-secret")
  assert.deepEqual(JSON.parse(store.values.get("EMAIL_ROLE_LIMITS")!), { duke: 0, knight: -1 })
  assert.equal(JSON.parse(store.values.get("RESEND_CONFIG")!)["example.com"].apiKey, "synthetic-resend")
})

test("invalid explicit settings fail without exposing values", () => {
  for (const [name, value] of Object.entries({
    DEFAULT_ROLE: "emperor", MAX_EMAILS: "0", EMAIL_DOMAINS: ",,", TURNSTILE_ENABLED: "yes", EMAIL_ROLE_LIMITS: '{"duke":-2}',
    RESEND_CONFIG: '{"example.com":{"enabled":true,"apiKey":""}}',
    CATCHALL_EMAIL: '{"example.com":{"address":"bad@@example.com","enabled":true}}',
  })) assert.throws(() => readAdminDeploymentConfig({ [name]: value }), new RegExp(`Invalid deployment setting: ${name}`))
  assert.throws(() => readAdminDeploymentConfig({ RESEND_CONFIG: "private-synthetic-value" }), error => {
    assert.equal(String(error).includes("private-synthetic-value"), false)
    return true
  })
})

test("cross-setting validation runs before any writes and retained Turnstile keys remain usable", async () => {
  for (const options of [
    { TURNSTILE_ENABLED: "true" },
    { RESEND_CONFIG: '{"foreign.example":{"enabled":false,"apiKey":""}}' },
    { CATCHALL_EMAIL: '{"foreign.example":{"address":"catch@foreign.example","enabled":true}}' },
  ]) {
    const store = configStore()
    await assert.rejects(applyAdminSiteSettings(readAdminDeploymentConfig({ EMAIL_DOMAIN: "example.com", ...options }), store), /Invalid deployment setting/)
    assert.deepEqual(store.writes, [])
  }
  const store = configStore({ EMAIL_DOMAINS: "example.com", TURNSTILE_SITE_KEY: "retained-site", TURNSTILE_SECRET_KEY: "retained-secret" })
  await applyAdminSiteSettings(readAdminDeploymentConfig({ TURNSTILE_ENABLED: "true" }), store)
  assert.deepEqual(store.writes, ["TURNSTILE_ENABLED"])
})

test("Catch-all setup preserves mailbox identity and messages across retries and renames", async () => {
  const { sqlite } = createTestDatabase()
  try {
    sqlite.exec("INSERT INTO user(id,username) VALUES('owner','admin'); INSERT INTO role(id,name) VALUES('emperor','emperor'); INSERT INTO user_role(user_id,role_id) VALUES('owner','emperor')")
    const query = async (sql: string, params: string[] = []) => sqlite.prepare(sql).all(...params)
    const store = configStore({ EMAIL_DOMAINS: "example.com" })
    const config = readAdminDeploymentConfig({ CATCHALL_EMAIL: '{"example.com":{"address":"catch@example.com","enabled":true,"showAlways":false}}', CATCHALL_OWNER_USERNAME: "admin" })
    await applyAdminCatchAllSettings(config, store, query)
    const mailbox = sqlite.prepare("SELECT * FROM email").get()!
    sqlite.prepare("INSERT INTO message(id,emailId,subject,content,received_at,sent_at) VALUES('message',?,'subject','body',0,0)").run(mailbox.id)
    await applyAdminCatchAllSettings(config, store, query)
    const renamed = readAdminDeploymentConfig({ CATCHALL_EMAIL: '{"example.com":{"address":"renamed@example.com","enabled":false,"showAlways":true}}' })
    await applyAdminCatchAllSettings(renamed, store, query)
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM email").get()?.n, 1)
    assert.equal(sqlite.prepare("SELECT id FROM email WHERE address='renamed@example.com'").get()?.id, mailbox.id)
    assert.equal(sqlite.prepare("SELECT emailId FROM message").get()?.emailId, mailbox.id)
    assert.equal(JSON.parse(store.values.get("CATCHALL_EMAIL")!)["example.com"].enabled, false)
  } finally { sqlite.close() }
})

test("Catch-all setup rejects missing owners and occupied addresses before changing mailboxes", async () => {
  const { sqlite } = createTestDatabase()
  try {
    const query = async (sql: string, params: string[] = []) => sqlite.prepare(sql).all(...params)
    const store = configStore()
    const config = readAdminDeploymentConfig({ CATCHALL_EMAIL: '{"example.com":{"address":"catch@example.com","enabled":true}}' })
    await assert.rejects(applyAdminCatchAllSettings(config, store, query), /emperor account/)
    sqlite.exec("INSERT INTO user(id,username) VALUES('owner','admin'),('other','other'); INSERT INTO role(id,name) VALUES('emperor','emperor'); INSERT INTO user_role(user_id,role_id) VALUES('owner','emperor'); INSERT INTO email(id,address,userId,created_at,expires_at) VALUES('taken','catch@example.com','other',0,1000)")
    await assert.rejects(applyAdminCatchAllSettings(config, store, query), /already owned/)
    assert.equal(sqlite.prepare("SELECT userId FROM email WHERE id='taken'").get()?.userId, "other")
    assert.deepEqual(store.writes, [])
  } finally { sqlite.close() }
})
