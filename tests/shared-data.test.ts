import test, { after, beforeEach, mock } from "node:test"
import assert from "node:assert/strict"
import { drizzle } from "drizzle-orm/d1"
import * as schema from "../app/lib/schema"
import { createTestDatabase } from "./helpers/database"

const { sqlite, d1 } = createTestDatabase()
const db = drizzle(d1, { schema })
mock.module("../app/lib/db.ts", { namedExports: { createDb: () => db } })
const { getSharedEmail, getSharedEmailMessages, getSharedMessage } = await import("../app/lib/shared-data")

beforeEach(() => {
  sqlite.exec("DELETE FROM email")
  const mailbox = sqlite.prepare("INSERT INTO email(id,address,created_at,expires_at) VALUES(?,?,0,?)")
  for (const id of ["shared", "private"]) mailbox.run(id, `${id}@example.com`, 8_640_000_000_000_000)
  const message = sqlite.prepare("INSERT INTO message(id,emailId,subject,content,received_at,sent_at,type) VALUES(?,?,?,'private body',?,?,?)")
  message.run("received-a", "shared", "Older tie", 100, 0, "received")
  message.run("received-b", "shared", "Newer tie", 100, 0, "received")
  message.run("legacy", "shared", "Legacy received", 50, 0, null)
  message.run("sent", "shared", "Private sent message", 200, 200, "sent")
  message.run("other-mailbox", "private", "Other owner's message", 300, 0, "received")
  sqlite.exec("INSERT INTO email_share(id,email_id,token,created_at) VALUES('email-share','shared','mailbox-token',0)")
  sqlite.exec("INSERT INTO message_share(id,message_id,token,created_at) VALUES('message-share','received-b','message-token',0)")
})
after(() => sqlite.close())

test("mailbox shares expose only received messages from the shared mailbox", async () => {
  const email = await getSharedEmail("mailbox-token")
  assert.equal(email?.id, "shared")
  const result = await getSharedEmailMessages("mailbox-token")
  assert.deepEqual(result.messages.map(message => message.id), ["received-b", "received-a", "legacy"])
  assert.equal(result.total, 3)
  assert.equal(result.nextCursor, null)
  for (const message of result.messages) {
    assert.equal(Object.hasOwn(message, "content"), false)
    assert.equal(Object.hasOwn(message, "html"), false)
  }
  const detail = await getSharedMessage("message-token")
  assert.equal(detail?.id, "received-b")
  assert.equal(detail?.content, "private body")
  assert.equal(detail?.emailAddress, "shared@example.com")
})

test("shared message pagination uses a stable timestamp and ID tie-breaker", async () => {
  const result = await getSharedEmailMessages("mailbox-token", 1)
  assert.equal(result.total, 3)
  assert.deepEqual(result.messages.map(message => message.id), ["received-b"])
  assert.ok(result.nextCursor)
  // Inspect the cursor independently of the production decoder.
  assert.deepEqual(JSON.parse(Buffer.from(result.nextCursor, "base64").toString("utf8")), { timestamp: 100, id: "received-b" })
  assert.equal((await getSharedEmailMessages("mailbox-token", 3)).nextCursor, null)
})

for (const invalidation of ["unknown token", "expired share", "expired mailbox", "revoked share", "deleted mailbox"]) {
  test(`shared-data helpers deny access after ${invalidation}`, async () => {
    if (invalidation === "expired share") sqlite.exec("UPDATE email_share SET expires_at = 0; UPDATE message_share SET expires_at = 0")
    if (invalidation === "expired mailbox") sqlite.exec("UPDATE email SET expires_at = 0 WHERE id = 'shared'")
    if (invalidation === "revoked share") sqlite.exec("DELETE FROM email_share; DELETE FROM message_share")
    if (invalidation === "deleted mailbox") sqlite.exec("DELETE FROM email WHERE id = 'shared'")
    const emailToken = invalidation === "unknown token" ? "unknown" : "mailbox-token"
    const messageToken = invalidation === "unknown token" ? "unknown" : "message-token"
    assert.equal(await getSharedEmail(emailToken), null)
    assert.deepEqual(await getSharedEmailMessages(emailToken), { messages: [], nextCursor: null, total: 0 })
    assert.equal(await getSharedMessage(messageToken), null)
  })
}
