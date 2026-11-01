import test, { after, beforeEach, mock } from "node:test"
import assert from "node:assert/strict"
import { NextRequest } from "next/server"
import { drizzle } from "drizzle-orm/d1"
import * as schema from "../app/lib/schema"
import { createTestDatabase } from "./helpers/database"
import { buildDefaultRoleBackfillSql } from "../app/lib/database-statements"
import { encode } from "next-auth/jwt"

const { sqlite, d1 } = createTestDatabase()
const db = drizzle(d1, { schema })
const config = new Map<string, string>()
process.env.AUTH_SECRET = "test-only-auth-secret-not-used-in-production"
process.env.AUTH_TRUST_HOST = "true"
mock.module("../app/lib/db.ts", { namedExports: { createDb: () => db } })
mock.module("@opennextjs/cloudflare", { namedExports: { getCloudflareContext: () => ({ env: { DB: d1, SITE_CONFIG: { get: async (key: string) => config.get(key) ?? null } } }) } })

const { GET } = await import("../app/lib/auth")

const COOKIE_NAME = "__Secure-authjs.session-token"

beforeEach(() => {
  sqlite.exec("DROP TRIGGER IF EXISTS nextmail_default_role_backfill; DROP TABLE IF EXISTS nextmail_migration_state")
  sqlite.exec("DELETE FROM user_role; DELETE FROM api_keys; DELETE FROM user; DELETE FROM role")
  config.clear()
})
after(() => sqlite.close())

async function sessionCookie(userId: string) {
  const token = await encode({
    token: { id: userId, name: "session", username: "session" },
    secret: process.env.AUTH_SECRET!,
    salt: COOKIE_NAME,
  })
  return `${COOKIE_NAME}=${token}`
}

test("a role-less account's session grants no role and writes no user_role row", async () => {
  sqlite.exec("INSERT INTO user(id,username) VALUES('role-less','role-less')")
  const cookie = await sessionCookie("role-less")

  const response = await GET(new NextRequest("https://app.example.com/api/auth/session", {
    headers: { cookie },
  }))
  assert.equal(response.status, 200)
  const session = await response.json() as { user?: { id?: string; roles?: { name: string }[] } } | null
  assert.equal(session?.user?.id, "role-less")
  assert.deepEqual(session?.user?.roles, [], "a role-less account must not be granted a role")
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM user_role").get()?.n, 0)
})

test("an account with a role keeps exactly that role and is not re-granted", async () => {
  sqlite.exec("INSERT INTO user(id,username) VALUES('assigned','assigned'); INSERT INTO role(id,name) VALUES('knight-role','knight')")
  sqlite.exec("INSERT INTO user_role(user_id,role_id) VALUES('assigned','knight-role')")
  const cookie = await sessionCookie("assigned")

  const response = await GET(new NextRequest("https://app.example.com/api/auth/session", {
    headers: { cookie },
  }))
  const session = await response.json() as { user?: { roles?: { name: string }[] } } | null
  assert.deepEqual(session?.user?.roles?.map(role => role.name), ["knight"])
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM user_role").get()?.n, 1)
})

test("the default-role backfill runs once and does not restore revoked roles", () => {
  sqlite.exec("INSERT INTO user(id,username) VALUES('legacy','legacy'),('assigned','assigned')")
  sqlite.exec("INSERT INTO role(id,name) VALUES('knight-role','knight')")
  sqlite.exec("INSERT INTO user_role(user_id,role_id) VALUES('assigned','knight-role')")

  const runDefaultRoleBackfill = (role: string) => {
    sqlite.exec(buildDefaultRoleBackfillSql(role))
  }

  runDefaultRoleBackfill("knight")

  const legacyRole = sqlite.prepare("SELECT r.name FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE ur.user_id = 'legacy'").get() as { name: string } | undefined
  assert.equal(legacyRole?.name, "knight")
  const assignedRoles = sqlite.prepare("SELECT r.name FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE ur.user_id = 'assigned'").all() as { name: string }[]
  assert.deepEqual(assignedRoles.map(role => role.name), ["knight"])
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM user_role").get()?.n, 2)

  // A later migration invocation must not undo an intentional revocation or
  // grant the old default role to accounts created after the one-time backfill.
  sqlite.exec("DELETE FROM user_role WHERE user_id = 'legacy'; INSERT INTO user(id,username) VALUES('late','late')")
  runDefaultRoleBackfill("duke")

  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM user_role WHERE user_id = 'legacy'").get()?.n, 0)
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM user_role WHERE user_id = 'late'").get()?.n, 0)
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM user_role WHERE user_id = 'assigned'").get()?.n, 1)
  assert.equal(sqlite.prepare("SELECT completed FROM nextmail_migration_state WHERE id = 'default-role-backfill'").get()?.completed, 1)
})

test("a failed default-role backfill can retry without retaining partial grants", () => {
  sqlite.exec("INSERT INTO user(id,username) VALUES('retry','retry')")
  sqlite.exec(`CREATE TRIGGER fail_default_role_backfill
    BEFORE INSERT ON user_role
    WHEN NEW.user_id = 'retry'
    BEGIN
      SELECT RAISE(ABORT, 'simulated backfill failure');
    END;`)

  assert.throws(() => sqlite.exec(buildDefaultRoleBackfillSql("knight")), /simulated backfill failure/)
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM user_role WHERE user_id = 'retry'").get()?.n, 0)
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM nextmail_migration_state WHERE id = 'default-role-backfill'").get()?.n, 0)
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM role WHERE id = 'backfill-default-role'").get()?.n, 0)

  sqlite.exec("DROP TRIGGER fail_default_role_backfill")
  sqlite.exec(buildDefaultRoleBackfillSql("knight"))
  assert.equal(sqlite.prepare("SELECT r.name FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE ur.user_id = 'retry'").get()?.name, "knight")

  sqlite.exec("DELETE FROM user_role WHERE user_id = 'retry'")
  sqlite.exec(buildDefaultRoleBackfillSql("knight"))
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM user_role WHERE user_id = 'retry'").get()?.n, 0)
})

test("the default-role backfill rejects a role that is not a site role", () => {
  assert.throws(() => buildDefaultRoleBackfillSql("emperor"), /Unsupported default role/)
  assert.throws(() => buildDefaultRoleBackfillSql("'; DROP TABLE user; --"), /Unsupported default role/)
})
