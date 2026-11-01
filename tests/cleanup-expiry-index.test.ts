import test from "node:test"
import assert from "node:assert/strict"
import type { DatabaseSync } from "node:sqlite"
import cleanup from "../workers/cleanup"
import { createTestDatabase } from "./helpers/database"
import {
  CLEANUP_EMAIL_SHARES_SQL,
  CLEANUP_MESSAGE_SHARES_SQL,
  CLEANUP_API_KEYS_SQL,
} from "../app/lib/database-statements"

// The cleanup worker reads expired rows by expires_at on every batch.
const resources = [
  { table: "email_share", statement: CLEANUP_EMAIL_SHARES_SQL, index: "email_share_expires_at_idx" },
  { table: "message_share", statement: CLEANUP_MESSAGE_SHARES_SQL, index: "message_share_expires_at_idx" },
  { table: "api_keys", statement: CLEANUP_API_KEYS_SQL, index: "api_keys_expires_at_idx" },
] as const

function explain(sqlite: DatabaseSync, sql: string, params: unknown[]) {
  const rows = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as { detail: string }[]
  return rows.map(row => row.detail)
}

function scans(details: string[], table: string) {
  return details.some(detail => new RegExp(`SCAN ${table}\\b`).test(detail))
}

// Keeps the seeded mailbox alive so share deletions stay observable.
function seed(sqlite: DatabaseSync, now: number) {
  sqlite.exec("INSERT INTO user(id) VALUES('owner')")
  sqlite.exec("INSERT INTO email(id,address,created_at,expires_at) VALUES('mailbox','mailbox@example.test',0,8640000000000)")
  sqlite.exec("INSERT INTO message(id,emailId,subject,content,received_at,sent_at) VALUES('message','mailbox','s','c',0,0)")
  for (let index = 0; index < 3; index++) {
    sqlite.exec(`INSERT INTO email_share(id,email_id,token,created_at,expires_at) VALUES('expired-share-${index}','mailbox','expired-share-token-${index}',0,${now - 1000})`)
    sqlite.exec(`INSERT INTO message_share(id,message_id,token,created_at,expires_at) VALUES('expired-message-share-${index}','message','expired-message-share-token-${index}',0,${now - 1000})`)
    sqlite.exec(`INSERT INTO api_keys(id,user_id,name,key,created_at,expires_at) VALUES('expired-key-${index}','owner','expired-key-${index}','expired-key-value-${index}',0,${Math.floor(now / 1000) - 10})`)
  }
  sqlite.exec(`INSERT INTO email_share(id,email_id,token,created_at,expires_at) VALUES('active-share','mailbox','active-share-token',0,${now + 60000})`)
  sqlite.exec(`INSERT INTO message_share(id,message_id,token,created_at,expires_at) VALUES('active-message-share','message','active-message-share-token',0,${now + 60000})`)
  sqlite.exec(`INSERT INTO api_keys(id,user_id,name,key,created_at,expires_at) VALUES('active-key','owner','active-key','active-key-value',0,${Math.floor(now / 1000) + 3600})`)
}

test("the expired-row cleanup reads shares and API keys through the expires_at index", async t => {
  const { sqlite } = createTestDatabase()
  t.after(() => sqlite.close())
  seed(sqlite, 1_800_000_000_000)

  for (const resource of resources) {
    const indexes = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name = ?").all(resource.table, resource.index)
    assert.equal(indexes.length, 1, `${resource.index} must exist on ${resource.table}`)

    // The selection shape stays the one the cleanup worker issues.
    assert.match(resource.statement, /WHERE expires_at <= \? ORDER BY expires_at, id LIMIT \?/, resource.table)

    const details = explain(sqlite, resource.statement, [0, 100])
    assert.equal(scans(details, resource.table), false, `${resource.table} must not be scanned: ${details.join(" | ")}`)
    assert.equal(details.some(detail => detail.includes(resource.index)), true, `${resource.index} must be used: ${details.join(" | ")}`)
  }
})

test("the expired-row selection scans the tables when the expires_at index is missing", async t => {
  const { sqlite } = createTestDatabase()
  t.after(() => sqlite.close())
  // Drop the new indexes to reproduce the schema that shipped before migration 0025.
  for (const resource of resources) {
    const exists = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(resource.index)
    if (exists) sqlite.exec(`DROP INDEX ${resource.index}`)
  }
  seed(sqlite, 1_800_000_000_000)

  for (const resource of resources) {
    const details = explain(sqlite, resource.statement, [0, 100])
    assert.equal(scans(details, resource.table), true, `the unindexed schema must scan ${resource.table}: ${details.join(" | ")}`)
    assert.equal(details.some(detail => detail.includes(resource.index)), false, `${resource.index} must be unused without the index: ${details.join(" | ")}`)
  }
})

test("the cleanup still removes only expired shares and API keys with the index in place", async t => {
  const { sqlite, d1 } = createTestDatabase()
  t.after(() => sqlite.close())
  const now = 1_800_000_000_000
  t.mock.method(Date, "now", () => now)
  t.mock.method(console, "info", () => {})
  seed(sqlite, now)

  await cleanup.scheduled({} as ScheduledEvent, { DB: d1 })

  const activeIds = { email_share: "active-share", message_share: "active-message-share", api_keys: "active-key" }
  for (const table of ["email_share", "message_share", "api_keys"] as const) {
    assert.deepEqual(sqlite.prepare(`SELECT id FROM ${table} ORDER BY id`).all().map(row => row.id), [activeIds[table]], table)
  }
})
