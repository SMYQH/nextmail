import test from "node:test"
import assert from "node:assert/strict"
import { parseShareExpiry } from "../app/lib/share-expiry"

test("omitted or zero expiry means a permanent share link", () => {
  assert.equal(parseShareExpiry({}), null)
  assert.equal(parseShareExpiry({ expiresIn: 0 }), null)
  assert.equal(parseShareExpiry({ expiresIn: undefined }), null)
})

test("a positive expiry resolves to a timestamp in the future", () => {
  const before = Date.now()
  const expiresAt = parseShareExpiry({ expiresIn: 60_000 })
  assert.ok(expiresAt instanceof Date)
  assert.ok(expiresAt.getTime() >= before + 60_000)
  assert.ok(expiresAt.getTime() <= Date.now() + 60_000)
})

test("unknown extra properties are ignored", () => {
  assert.equal(parseShareExpiry({ expiresIn: 0, note: "ignored" }), null)
})

test("malformed bodies and expiry values are rejected", () => {
  for (const body of [undefined, null, "", 0, "0", [], true, { expiresIn: null }, { expiresIn: "0" },
    { expiresIn: true }, { expiresIn: -1 }, { expiresIn: 0.5 }, { expiresIn: 1e309 }, { expiresIn: Number.MAX_SAFE_INTEGER + 2 }]) {
    assert.equal(parseShareExpiry(body), undefined, JSON.stringify(body))
  }
})
