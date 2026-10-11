import test from "node:test"
import assert from "node:assert/strict"
import { DrizzleQueryError } from "drizzle-orm/errors"
import { safeErrorMetadata } from "../app/lib/safe-error"

test("safe error metadata keeps database values and overridden names out of logs", () => {
  const secret = "synthetic-db-secret-5d39"
  const body = "synthetic-email-body-4b72"
  const error = new Error(`Failed query: INSERT INTO message VALUES (?)\nparams: ${secret}, ${body}`)
  error.name = secret
  Object.defineProperty(error, "constructor", { value: { name: secret } })

  const logged = JSON.stringify(safeErrorMetadata(error))
  assert.deepEqual(JSON.parse(logged), { errorType: "Error" })
  assert.equal(logged.includes(secret), false)
  assert.equal(logged.includes(body), false)
})

test("safe error metadata labels Drizzle query errors without exposing their messages", () => {
  const secret = "synthetic-api-key-8c11"
  const error = new DrizzleQueryError("INSERT INTO api_keys VALUES (?)", [secret])

  const logged = JSON.stringify(safeErrorMetadata(error))
  assert.deepEqual(JSON.parse(logged), { errorType: "DrizzleQueryError" })
  assert.equal(logged.includes(secret), false)
})
