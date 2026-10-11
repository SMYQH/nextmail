import test from "node:test"
import assert from "node:assert/strict"
import { hashPassword, comparePassword, needsPasswordUpgrade } from "../app/lib/password"

test("password hashes are salted and verify the complete Unicode password", async () => {
  const password = "🔐".repeat(24)
  const a = await hashPassword(password)
  const b = await hashPassword(password)
  assert.notEqual(a, b)
  assert.equal(needsPasswordUpgrade(a), false)
  assert.equal(await comparePassword(password, a), true)
  assert.equal(await comparePassword(password + "different", a), false)
  assert.equal(await comparePassword(password, null), false)
})

test("existing SHA-256 accounts can log in and are marked for upgrade", async () => {
  const password = "legacy-password"
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password + (process.env.AUTH_SECRET || "")))
  const legacy = Buffer.from(digest).toString("base64")
  assert.equal(needsPasswordUpgrade(legacy), true)
  assert.equal(await comparePassword(password, legacy), true)
  assert.equal(await comparePassword("wrong", legacy), false)
})
