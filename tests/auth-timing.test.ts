import test, { after, beforeEach, mock } from "node:test"
import assert from "node:assert/strict"
import { NextRequest } from "next/server"
import { drizzle } from "drizzle-orm/d1"
import * as schema from "../app/lib/schema"
import { createTestDatabase } from "./helpers/database"
import bcryptjs from "bcryptjs"

const { sqlite, d1 } = createTestDatabase()
const db = drizzle(d1, { schema })
process.env.AUTH_SECRET = "test-only-auth-secret-not-used-in-production"
process.env.AUTH_TRUST_HOST = "true"

// Record the bcrypt comparisons the credential flow performs, so the test can assert on
// the password work itself instead of on elapsed wall-clock time.
const comparisons: string[] = []
const originalCompare = bcryptjs.compare
mock.module("bcryptjs", {
  defaultExport: bcryptjs,
  namedExports: {
    ...bcryptjs,
    compare: async (data: string, stored: string) => {
      comparisons.push(stored)
      return originalCompare(data, stored)
    },
  },
})

mock.module("../app/lib/db.ts", { namedExports: { createDb: () => db } })
mock.module("@opennextjs/cloudflare", { namedExports: { getCloudflareContext: () => ({ env: { DB: d1, SITE_CONFIG: { get: async () => null } } }) } })

const { GET, POST } = await import("../app/lib/auth")
const { getDummyPasswordHash } = await import("../app/lib/password")

beforeEach(() => {
  sqlite.exec("DELETE FROM api_keys; DELETE FROM user; DELETE FROM role")
  comparisons.length = 0
})
after(() => {
  sqlite.close()
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

test("the dummy credential is a stable cost-10 bcrypt-sha256 hash", async () => {
  const first = await getDummyPasswordHash()
  const second = await getDummyPasswordHash()

  assert.equal(first, second)
  assert.ok(first.startsWith("bcrypt-sha256:"), first)
  assert.match(first.slice("bcrypt-sha256:".length), /^\$2[aby]\$10\$/)
})

test("an unknown username still performs one bcrypt comparison against the dummy hash", async () => {
  const dummyHash = await getDummyPasswordHash()

  const url = await credentialsCallback({ username: "does-not-exist", password: "password123" })

  assert.equal(comparisons.length, 1)
  assert.equal(comparisons[0], dummyHash.slice("bcrypt-sha256:".length))
  assert.equal(url.searchParams.get("error"), "CredentialsSignin")
  assert.equal(url.searchParams.get("code"), "invalid_credentials")
})

test("a known username with a wrong password performs one bcrypt comparison against its own hash", async () => {
  const { hashPassword } = await import("../app/lib/password")
  const stored = await hashPassword("password123")
  sqlite.prepare("INSERT INTO user(id,username,password) VALUES('timing-user','timing-user',?)").run(stored)

  const url = await credentialsCallback({ username: "timing-user", password: "wrong-password" })

  assert.equal(comparisons.length, 1)
  assert.equal(comparisons[0], stored.slice("bcrypt-sha256:".length))
  assert.equal(url.searchParams.get("error"), "CredentialsSignin")
  assert.equal(url.searchParams.get("code"), "invalid_credentials")
})

test("unknown and known usernames return an identical error response", async () => {
  const { hashPassword } = await import("../app/lib/password")
  const stored = await hashPassword("password123")
  sqlite.prepare("INSERT INTO user(id,username,password) VALUES('timing-user','timing-user',?)").run(stored)

  const unknown = await credentialsCallback({ username: "does-not-exist", password: "password123" })
  const known = await credentialsCallback({ username: "timing-user", password: "wrong-password" })

  assert.equal(unknown.searchParams.get("error"), known.searchParams.get("error"))
  assert.equal(unknown.searchParams.get("code"), known.searchParams.get("code"))
  assert.equal(unknown.pathname, known.pathname)
  assert.equal(unknown.searchParams.get("error"), "CredentialsSignin")
  assert.equal(unknown.searchParams.get("code"), "invalid_credentials")
})
