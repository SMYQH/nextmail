import test, { after, beforeEach, mock } from "node:test"
import assert from "node:assert/strict"
import { NextRequest } from "next/server"
import { drizzle } from "drizzle-orm/d1"
import { DrizzleQueryError } from "drizzle-orm/errors"
import * as schema from "../app/lib/schema"
import { createTestDatabase } from "./helpers/database"
import { getAuthErrorMessage } from "../app/lib/auth-errors"
import { encode } from "next-auth/jwt"
import { ROLES } from "../app/lib/permissions"

const { sqlite, d1 } = createTestDatabase()
const db = drizzle(d1, { schema })
const config = new Map<string, string>()
let databaseInitializationFailure: Error | undefined
let defaultRoleLookupBarrier: {
  started: () => void
  wait: Promise<void>
  release: () => void
} | undefined
process.env.AUTH_SECRET = "test-only-auth-secret-not-used-in-production"
process.env.AUTH_TRUST_HOST = "true"
mock.module("../app/lib/db.ts", { namedExports: { createDb: () => {
  if (databaseInitializationFailure) throw databaseInitializationFailure
  return db
} } })
mock.module("@opennextjs/cloudflare", { namedExports: { getCloudflareContext: () => ({ env: { DB: d1, SITE_CONFIG: { get: async (key: string) => {
  if (key === "DEFAULT_ROLE" && defaultRoleLookupBarrier) {
    defaultRoleLookupBarrier.started()
    await defaultRoleLookupBarrier.wait
  }
  return config.get(key) ?? null
} } } }) } })

const { GET, POST, register, hasEmperor, assignRoleToUser, findOrCreateRole } = await import("../app/lib/auth")
const { CredentialsError } = await import("../app/lib/credentials-error")
const registration = await import("../app/api/auth/register/route")
const { middleware } = await import("../middleware")

beforeEach(t => {
  assert.ok("mock" in t)
  sqlite.exec("DELETE FROM user; DELETE FROM role")
  config.clear()
  defaultRoleLookupBarrier = undefined
  const network = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected outbound request in auth test")
  })
  t.after(() => assert.equal(network.mock.callCount(), 0))
})
after(() => sqlite.close())

function pauseDefaultRoleLookup() {
  let started!: () => void
  let release!: () => void
  const startedPromise = new Promise<void>(resolve => { started = resolve })
  const wait = new Promise<void>(resolve => { release = resolve })
  defaultRoleLookupBarrier = { started, wait, release }
  return { started: startedPromise, release }
}

test("middleware authenticates HTTP and HTTPS session cookies with the request protocol", async () => {
  sqlite.exec("INSERT INTO user(id,username) VALUES('preview-user','preview'); INSERT INTO role(id,name) VALUES('duke','duke'); INSERT INTO user_role(user_id,role_id) VALUES('preview-user','duke')")
  for (const protocol of ["http", "https"]) {
    const cookieName = protocol === "https" ? "__Secure-authjs.session-token" : "authjs.session-token"
    const token = await encode({ token: { id: "preview-user", name: "preview" }, secret: process.env.AUTH_SECRET!, salt: cookieName })
    const cookie = `${cookieName}=${token}`
    const session = await GET(new NextRequest(`${protocol}://localhost:8787/api/auth/session`, { headers: { cookie } }))
    assert.equal((await session.json() as { user: { id: string } }).user.id, "preview-user")
    for (const [route, method] of [
      ["/api/config", "GET"],
      ["/api/roles/init-emperor", "GET"],
      ["/api/roles/init-emperor", "POST"],
      ["/en/profile", "GET"],
      ["/zh-CN/profile", "GET"],
    ]) {
      const response = await middleware(new Request(`${protocol}://localhost:8787${route}`, {
        method,
        headers: { cookie },
      }))
      assert.equal(response.headers.get("x-middleware-next"), "1")
      assert.equal(response.headers.get("x-middleware-request-x-forwarded-proto"), protocol)
      assert.equal(response.headers.get("x-middleware-request-cookie"), cookie)
    }
    const unauthorized = await middleware(new Request(`${protocol}://localhost:8787/api/config`))
    assert.equal(unauthorized.status, 401)
  }
})

test("emperor browser navigation is allowed but claims still require authentication", async () => {
  const url = "https://app.example.com/api/roles/init-emperor"
  const navigation = await middleware(new Request(url))
  assert.equal(navigation.headers.get("x-middleware-next"), "1")
  assert.equal((await middleware(new Request(url, { method: "POST" }))).status, 401)
  assert.equal((await middleware(new Request(`${url}/other`))).status, 401)
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM user_role").get()?.n, 0)
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM user").get()?.n, 0)
})

test("site owner availability reflects assignments without initializing any role", async () => {
  assert.equal(await hasEmperor(), false)
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM role").get()?.n, 0)
  sqlite.exec("INSERT INTO user(id) VALUES('owner'); INSERT INTO role(id,name) VALUES('emperor','emperor'),('duke','duke'); INSERT INTO user_role(user_id,role_id) VALUES('owner','duke')")
  assert.equal(await hasEmperor(), false)
  sqlite.exec("UPDATE user_role SET role_id = 'emperor' WHERE user_id = 'owner'")
  assert.equal(await hasEmperor(), true)
  assert.deepEqual(sqlite.prepare("SELECT user_id, role_id FROM user_role").all().map(row => ({ ...row })), [{ user_id: "owner", role_id: "emperor" }])
})

test("first sign-in preserves an administrator role assigned during default-role lookup", async () => {
  config.set("DEFAULT_ROLE", ROLES.DUKE)
  const barrier = pauseDefaultRoleLookup()
  const signIn = credentialsCallback({ action: "register", username: "first-login", password: "password123" })
  await barrier.started

  const user = sqlite.prepare("SELECT id FROM user WHERE username = 'first-login'").get()
  assert.ok(user)
  const knight = await findOrCreateRole(db, ROLES.KNIGHT)
  await assignRoleToUser(db, user.id as string, knight.id)

  barrier.release()
  const callbackUrl = await signIn
  assert.equal(callbackUrl.searchParams.has("error"), false)
  assert.equal(callbackUrl.origin, "https://app.example.com")

  const persistedRole = sqlite.prepare("SELECT r.name FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE ur.user_id = ?").get(user.id)
  assert.equal(persistedRole?.name, ROLES.KNIGHT)
})

test("session initialization returns the role persisted during default-role lookup", async () => {
  config.set("DEFAULT_ROLE", ROLES.DUKE)
  sqlite.exec("INSERT INTO user(id,username) VALUES('session-race-user','session-race')")
  const cookieName = "__Secure-authjs.session-token"
  const token = await encode({
    token: { id: "session-race-user", name: "session-race", username: "session-race" },
    secret: process.env.AUTH_SECRET!,
    salt: cookieName,
  })
  const barrier = pauseDefaultRoleLookup()
  const sessionRequest = GET(new NextRequest("https://app.example.com/api/auth/session", {
    headers: { cookie: `${cookieName}=${token}` },
  }))
  await barrier.started

  const knight = await findOrCreateRole(db, ROLES.KNIGHT)
  await assignRoleToUser(db, "session-race-user", knight.id)
  barrier.release()

  const response = await sessionRequest
  assert.equal(response.status, 200)
  const session = await response.json() as { user: { roles: { name: string }[] } }
  assert.deepEqual(session.user.roles.map(role => role.name), [ROLES.KNIGHT])
  assert.deepEqual(
    sqlite.prepare("SELECT r.name FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE ur.user_id = 'session-race-user'").all().map(row => row.name),
    [ROLES.KNIGHT],
  )
})

test("explicit role assignment still replaces the user's previous role", async () => {
  sqlite.exec("INSERT INTO user(id) VALUES('admin-target')")
  const duke = await findOrCreateRole(db, ROLES.DUKE)
  const knight = await findOrCreateRole(db, ROLES.KNIGHT)
  await assignRoleToUser(db, "admin-target", duke.id)
  await assignRoleToUser(db, "admin-target", knight.id)

  assert.deepEqual(
    sqlite.prepare("SELECT r.name FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE ur.user_id = 'admin-target'").all().map(row => row.name),
    [ROLES.KNIGHT],
  )
})

async function credentialsCallback(values: Record<string, string>) {
  const csrf = await GET(new NextRequest("https://app.example.com/api/auth/csrf"))
  const { csrfToken } = await csrf.json() as { csrfToken: string }
  const cookie = csrf.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
  const response = await POST(new NextRequest("https://app.example.com/api/auth/callback/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Auth-Return-Redirect": "1", cookie },
    body: new URLSearchParams({ ...values, csrfToken }),
  }))
  const { url } = await response.json() as { url: string }
  return new URL(url)
}

test("duplicate registration survives the real Auth.js callback as a safe business code", async t => {
  t.mock.method(console, "error", () => {})
  sqlite.exec("INSERT INTO user(id,username,password) VALUES('existing','taken','unchanged')")
  const url = await credentialsCallback({ action: "register", username: "taken", password: "password123" })
  assert.equal(url.searchParams.get("error"), "CredentialsSignin")
  assert.equal(url.searchParams.get("code"), "username_taken")
  assert.equal(getAuthErrorMessage("CredentialsSignin", "username_taken"), "errors.usernameTaken")
  assert.equal(sqlite.prepare("SELECT password FROM user WHERE id = 'existing'").get()?.password, "unchanged")
  const legacyResponse = await registration.POST(new Request("https://app.example.com/api/auth/register", {
    method: "POST", body: JSON.stringify({ username: "taken", password: "password123" }),
  }))
  assert.equal(legacyResponse.status, 409)
  assert.deepEqual(await legacyResponse.json(), { error: "username_taken" })
})

test("concurrent registrations return one user and a username_taken error", async () => {
  const results = await Promise.allSettled([register("race", "password123"), register("race", "password123")])
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1)
  const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult
  assert.ok(rejected.reason instanceof CredentialsError)
  assert.equal(rejected.reason.code, "username_taken")
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM user WHERE username = 'race'").get()?.n, 1)
})

test("credentials validation and failed logins expose only expected codes", async t => {
  t.mock.method(console, "error", () => {})
  for (const [username, code] of [["invalid@name", "invalid_input"], ["missing", "invalid_credentials"]]) {
    const url = await credentialsCallback({ username, password: "password123" })
    assert.equal(url.searchParams.get("error"), "CredentialsSignin")
    assert.equal(url.searchParams.get("code"), code)
  }
  config.set("TURNSTILE_ENABLED", "true")
  config.set("TURNSTILE_SITE_KEY", "test-site")
  config.set("TURNSTILE_SECRET_KEY", "test-secret")
  try {
    const url = await credentialsCallback({ action: "register", username: "newuser", password: "password123" })
    assert.equal(url.searchParams.get("error"), "CredentialsSignin")
    assert.equal(url.searchParams.get("code"), "verification_required")
  } finally {
    config.clear()
  }
})

test("Auth.js credential database failures redact credentials and query details", async t => {
  const username = "userMarker42"
  const password = "passwordMarker42"
  const driverMessage = "driverMarker42"
  const failure = new DrizzleQueryError(
    "SELECT * FROM user WHERE username = ?",
    [username, password],
    new Error(driverMessage),
  )
  const prepare = d1.prepare.bind(d1)
  t.mock.method(d1, "prepare", (sql: string) => {
    if (sql.includes('from "user"')) throw failure
    return prepare(sql)
  })
  const logs: string[] = []
  t.mock.method(console, "error", (...args: Parameters<typeof console.error>) => {
    logs.push(args.map(value => typeof value === "string" ? value : JSON.stringify(value)).join(" "))
  })

  const url = await credentialsCallback({ username, password })
  const output = logs.join("\n")
  assert.ok(url.searchParams.get("error"))
  assert.match(output, /CallbackRouteError/)
  assert.doesNotMatch(output, /userMarker42|passwordMarker42|driverMarker42|SELECT \* FROM user/)
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM user").get()?.n, 0)
})

test("Auth.js configuration initialization failures are logged and rethrown safely", async t => {
  const marker = "cloudflareContextMarker42"
  const logs: string[] = []
  t.mock.method(console, "error", (...args: Parameters<typeof console.error>) => {
    logs.push(args.map(value => typeof value === "string" ? value : JSON.stringify(value)).join(" "))
  })
  databaseInitializationFailure = new Error(marker)
  try {
    await assert.rejects(
      GET(new NextRequest("https://app.example.com/api/auth/csrf")),
      /Authentication initialization failed/,
    )
  } finally {
    databaseInitializationFailure = undefined
  }

  const output = logs.join("\n")
  assert.match(output, /\[auth\]\[initialization\]/)
  assert.doesNotMatch(output, new RegExp(marker))
})

test("middleware propagates identity database failures without logging API keys", async t => {
  const apiKey = "apiKeyMarker42"
  const driverMessage = "driverMarker43"
  const failure = new DrizzleQueryError(
    "SELECT * FROM api_keys WHERE key = ?",
    [apiKey],
    new Error(driverMessage),
  )
  const prepare = d1.prepare.bind(d1)
  t.mock.method(d1, "prepare", (sql: string) => {
    if (sql.includes('from "api_keys"')) throw failure
    return prepare(sql)
  })
  const logs: string[] = []
  t.mock.method(console, "error", (...args: Parameters<typeof console.error>) => {
    logs.push(args.map(value => typeof value === "string" ? value : JSON.stringify(value)).join(" "))
  })

  await assert.rejects(
    middleware(new Request("https://app.example.com/api/config", { headers: { "X-API-Key": apiKey } })),
    /Request identity lookup failed/,
  )
  const output = logs.join("\n")
  assert.match(output, /DrizzleQueryError/)
  assert.doesNotMatch(output, /apiKeyMarker42|driverMarker43|SELECT \* FROM api_keys/)
})

test("registration persists a verifiable hash without returning password material", async () => {
  const response = await registration.POST(new Request("https://app.example.com/api/auth/register", {
    method: "POST", body: JSON.stringify({ username: "newuser", password: "password123" }),
  }))
  assert.equal(response.status, 200)
  const body = await response.json() as { user: { id: string; username: string } }
  assert.deepEqual(Object.keys(body.user).sort(), ["id", "image", "name", "username"])
  assert.equal(body.user.username, "newuser")
  const stored = sqlite.prepare("SELECT password FROM user WHERE id = ?").get(body.user.id)
  assert.ok(stored)
  assert.equal(typeof stored.password, "string")
  assert.notEqual(stored.password, "password123")
  const { comparePassword } = await import("../app/lib/password")
  assert.equal(await comparePassword("password123", stored.password as string), true)
  assert.equal(await comparePassword("wrong-password", stored.password as string), false)
})

test("invalid registration never creates an account", async t => {
  for (const input of [
    { username: "", password: "password123" },
    { username: "a".repeat(21), password: "password123" },
    { username: "invalid@name", password: "password123" },
    { username: "valid", password: "short" },
  ]) {
    await t.test(JSON.stringify(input), async () => {
      const response = await registration.POST(new Request("https://app.example.com/api/auth/register", {
        method: "POST", body: JSON.stringify(input),
      }))
      assert.equal(response.status, 400)
      assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM user").get()?.n, 0)
    })
  }
})
