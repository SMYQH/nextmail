import test from "node:test"
import assert from "node:assert/strict"
import { decodeCursor, encodeCursor, decodeArrivalCursor, encodeArrivalCursor } from "../app/lib/cursor"

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64")
const invalidCursor = { name: "InvalidCursorError", message: "Invalid cursor" }

test("pagination cursors preserve timestamps, Unicode IDs, and empty legacy boundaries", () => {
  for (const timestamp of [-8_640_000_000_000_000, -1, 0, 1_800_000_000_000, 8_640_000_000_000_000]) {
    for (const id of ["", "message-01", "邮件/é/🙂"]) {
      assert.deepEqual(decodeCursor(encodeCursor(timestamp, id)), { timestamp, id })
    }
  }
})

test("pagination cursors reject invalid JSON shapes, timestamps, and IDs", () => {
  for (const cursor of [
    "not-a-cursor", "", Buffer.from("{").toString("base64"),
    ...[null, [], false, 42, "cursor", {},
      { id: "message" }, { timestamp: 0 }, { timestamp: null, id: "message" },
      { timestamp: "0", id: "message" }, { timestamp: 0.5, id: "message" },
      { timestamp: 8_640_000_000_000_001, id: "message" },
      { timestamp: -8_640_000_000_000_001, id: "message" },
      { timestamp: 0, id: null }, { timestamp: 0, id: 1 },
      { timestamp: 0, id: {} }, { timestamp: 0, id: [] },
    ].map(encode),
    Buffer.from('{"timestamp":1e309,"id":"message"}').toString("base64"),
  ]) assert.throws(() => decodeCursor(cursor), invalidCursor)
})

test("arrival cursors preserve valid sequences and replay valid legacy timestamp cursors", () => {
  for (const sequence of [0, 1, 42, Number.MAX_SAFE_INTEGER]) {
    assert.equal(decodeArrivalCursor(encodeArrivalCursor(sequence)), sequence)
  }
  assert.equal(decodeArrivalCursor(encodeCursor(99, "")), 0)
  assert.equal(decodeArrivalCursor(encodeCursor(1_800_000_000_000, "message")), 0)
})

test("arrival cursors reject malformed input instead of silently replaying from zero", () => {
  for (const cursor of [
    "not-a-cursor", "", Buffer.from("{").toString("base64"),
    ...[null, [], false, 42, "cursor", {},
      { version: 1 }, { version: "1", sequence: 0 }, { version: 2, sequence: 0 },
      { version: 1, sequence: null }, { version: 1, sequence: "0" },
      { version: 1, sequence: -1 }, { version: 1, sequence: 0.5 },
      { version: 1, sequence: Number.MAX_SAFE_INTEGER + 1 },
      { timestamp: "99", id: "" }, { timestamp: 99 },
    ].map(encode),
  ]) assert.throws(() => decodeArrivalCursor(cursor), invalidCursor)
})
