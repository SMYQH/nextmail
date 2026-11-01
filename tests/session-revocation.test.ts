import test, { after, beforeEach, mock } from "node:test"
import assert from "node:assert/strict"
import { NextRequest } from "next/server"
import { drizzle } from "drizzle-orm/d1"
import * as schema from "../app/lib/schema"
import { createTestDatabase } from "./helpers/database"
import { encode } from "next-auth/jwt"
import { ROLES } from "../app/lib/permissions"

const { sqlite, d1 } = createTestDatabase()
const db = drizzle(d1, { schema })
let requestHeaders = new Headers()
process.env.AUTH_SECRET = "test-only-auth-secret-not-used-in-production"
process.env.AUTH_TRUST_HOST = "true"
mock.module("../app/lib/db.ts", { namedExports: { createDb: () => db } })
mock.module("next/headers", { namedExports: { headers: async () => requestHeaders, cookies: async () => new Map() } })
mock.module("@opennextjs/cloudflare", { namedExports: { getCloudflareContext: () => ({ env: { DB: d1, SITE_CONFIG: { get: async () => null } } }) } })

const { GET } = await import("../app/lib/auth")
const { proxy } = await import("../proxy")

const COOKIE_NAME = "__Secure-authjs.session-token"

beforeEach(() => {
  sqlite.exec("DELETE FROM api_keys; DELETE FROM user; DELETE FROM role")
  sqlite.exec("INSERT INTO user(id,username) VALUES('deleted-user','deleted'); INSERT INTO role(id,name) VALUES('duke','duke'); INSERT INTO user_role(user_id,role_id) VALUES('deleted-user','duke')")
  requestHeaders = new Headers()
})
after(() => sqlite.close())

async function sessionCookie(userId: string) {
  const token = await encode({
    token: { id: userId, name: "deleted", username: "deleted" },
    secret: process.env.AUTH_SECRET!,
    salt: COOKIE_NAME,
  })
  return `${COOKIE_NAME}=${token}`
}

test("a session issued before account deletion no longer authenticates", async t => {
  const cookie = await sessionCookie("deleted-user")
  const errors: unknown[][] = []
  t.mock.method(console, "error", (...values: Parameters<typeof console.error>) => { errors.push(values) })
  const statements: string[] = []
  const prepare = d1.prepare.bind(d1)
  t.mock.method(d1, "prepare", (sql: string) => {
    statements.push(sql)
    return prepare(sql)
  })

  // The account is deleted while the session cookie is still valid.
  sqlite.exec("DELETE FROM user WHERE id = 'deleted-user'")

  const session = await GET(new NextRequest("https://app.example.com/api/auth/session", {
    headers: { cookie },
  }))
  assert.equal(session.status, 200)
  const payload = await session.json() as { user?: { id?: string } } | null
  assert.equal(payload?.user?.id, undefined, "a deleted account must not keep an authenticated session")

  // A protected request with the same stale cookie is rejected instead of erroring.
  const response = await proxy(new Request("https://app.example.com/api/emails", {
    headers: { cookie },
  }))
  assert.equal(response.status, 401)

  // The missing account is resolved before any role row is written, so the
  // deleted user never reaches the foreign-key violation path.
  assert.deepEqual(errors, [], "a deleted account must not raise a server error")
  assert.equal(
    statements.some(sql => sql.includes("INSERT INTO \"user_role\"")),
    false,
    `no role row may be written for a deleted account: ${statements.join(" | ")}`,
  )
})

test("deleting an account through the user route invalidates the issued session", async () => {
  const cookie = await sessionCookie("deleted-user")
  const { DELETE } = await import("../app/api/users/[id]/route")
  // The emperor performs the deletion; the deleted account keeps its own cookie.
  sqlite.exec("INSERT INTO user(id,username) VALUES('owner','owner'); INSERT INTO role(id,name) VALUES('emperor','emperor'); INSERT INTO user_role(user_id,role_id) VALUES('owner','emperor')")
  const ownerCookie = await sessionCookie("owner")
  requestHeaders = new Headers({ cookie: ownerCookie })

  const deleted = await DELETE(new Request("https://app.example.com/api/users/deleted-user", {
    method: "DELETE",
  }), { params: Promise.resolve({ id: "deleted-user" }) })
  assert.equal(deleted.status, 200)

  requestHeaders = new Headers({ cookie })
  const response = await proxy(new Request("https://app.example.com/api/emails", {
    headers: { cookie },
  }))
  assert.equal(response.status, 401)
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM user WHERE id = 'deleted-user'").get()?.n, 0)
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM user_role WHERE user_id = 'deleted-user'").get()?.n, 0)
})

test("a live account keeps its session and roles", async () => {
  const cookie = await sessionCookie("deleted-user")
  const session = await GET(new NextRequest("https://app.example.com/api/auth/session", {
    headers: { cookie },
  }))
  const payload = await session.json() as { user?: { id?: string; roles?: { name: string }[] } } | null
  assert.equal(payload?.user?.id, "deleted-user")
  assert.deepEqual(payload?.user?.roles?.map(role => role.name), [ROLES.DUKE])
})
