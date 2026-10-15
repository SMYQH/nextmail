import test from "node:test"
import assert from "node:assert/strict"
import { mergeRefreshedMessages } from "../app/lib/message-list-refresh"

type Message = { id: string }

test("refresh preserves the current tail cursor when older messages remain in the merged list", () => {
  const result = mergeRefreshedMessages<Message>(
    [{ id: "new" }, { id: "recent" }],
    [{ id: "recent" }, { id: "older-1" }, { id: "older-2" }],
    "after-first-page",
    "after-loaded-pages",
  )

  assert.deepEqual(result, {
    messages: [{ id: "new" }, { id: "recent" }, { id: "older-1" }, { id: "older-2" }],
    nextCursor: "after-loaded-pages",
  })
})

test("refresh prepends new messages and pagination continues after the previous tail", () => {
  const existingMessages = [{ id: "recent" }, { id: "tail" }]
  const existingCursor = "after-tail"
  const result = mergeRefreshedMessages<Message>(
    [{ id: "new-1" }, { id: "new-2" }, { id: "recent" }],
    existingMessages,
    "after-refreshed-first-page",
    existingCursor,
  )

  assert.deepEqual(result, {
    messages: [{ id: "new-1" }, { id: "new-2" }, { id: "recent" }, { id: "tail" }],
    nextCursor: existingCursor,
  })

  const nextPageByCursor = new Map<string, Message[]>([
    ["after-tail", [{ id: "older" }]],
    ["after-refreshed-first-page", [{ id: "tail" }]],
  ])
  const paginatedMessages = [...result.messages, ...nextPageByCursor.get(result.nextCursor!)!]

  assert.deepEqual(paginatedMessages, [
    { id: "new-1" },
    { id: "new-2" },
    { id: "recent" },
    { id: "tail" },
    { id: "older" },
  ])
})

test("mailbox refresh after loading page two keeps the cursor after the loaded tail", () => {
  const loadedEmails = Array.from({ length: 40 }, (_, index) => ({ id: `email-${index + 1}` }))
  const result = mergeRefreshedMessages(
    loadedEmails.slice(0, 20),
    loadedEmails,
    "after-page-one",
    "after-page-two",
  )

  const nextPage = Array.from({ length: 20 }, (_, index) => ({ id: `email-${index + 41}` }))

  assert.equal(result.nextCursor, "after-page-two")
  assert.deepEqual(
    [...result.messages, ...nextPage].map(email => email.id),
    Array.from({ length: 60 }, (_, index) => `email-${index + 1}`),
  )
})

test("refresh resets pagination when there is no overlap with the current list", () => {
  const result = mergeRefreshedMessages<Message>(
    [{ id: "new-1" }, { id: "new-2" }],
    [{ id: "old-1" }, { id: "old-2" }],
    "after-new-page",
    "after-old-pages",
  )

  assert.deepEqual(result, {
    messages: [{ id: "new-1" }, { id: "new-2" }],
    nextCursor: "after-new-page",
  })
})

test("refresh includes new mailboxes after a pinned row and updates overlapping statistics", () => {
  const result = mergeRefreshedMessages(
    [{ id: "pinned", unread: 2 }, { id: "new", unread: 1 }, { id: "recent", unread: 0 }],
    [{ id: "pinned", unread: 1 }, { id: "recent", unread: 3 }, { id: "older", unread: 0 }],
    "first-page",
    "loaded-tail",
  )
  assert.deepEqual(result.messages, [
    { id: "pinned", unread: 2 }, { id: "new", unread: 1 },
    { id: "recent", unread: 0 }, { id: "older", unread: 0 },
  ])
  assert.equal(result.nextCursor, "loaded-tail")
})

test("pinned-only overlap resets the ordinary mailbox pagination cursor", () => {
  const pinned = { id: "catch-all", isCatchAll: true }
  const firstPage = [pinned, ...Array.from({ length: 20 }, (_, index) => ({ id: `box-${index}` }))]
  for (const oldMessages of [[pinned], [pinned, { id: "older" }]]) {
    const result = mergeRefreshedMessages<Message & { isCatchAll?: boolean }>(
      firstPage, oldMessages, "after-new-page", null, email => !email.isCatchAll,
    )
    assert.deepEqual(result.messages, firstPage)
    assert.equal(result.nextCursor, "after-new-page")
  }
})

test("ordinary mailbox overlap preserves the loaded tail alongside pinned rows", () => {
  const pinned = { id: "catch-all", isCatchAll: true }
  const result = mergeRefreshedMessages<Message & { isCatchAll?: boolean }>(
    [pinned, { id: "new" }, { id: "recent" }],
    [pinned, { id: "recent" }, { id: "older" }],
    "first-page", "loaded-tail", email => !email.isCatchAll,
  )
  assert.deepEqual(result.messages.map(email => email.id), ["catch-all", "new", "recent", "older"])
  assert.equal(result.nextCursor, "loaded-tail")
})

test("refresh removes a hidden pinned mailbox while preserving ordinary pagination", () => {
  const result = mergeRefreshedMessages<Message & { isCatchAll?: boolean }>(
    [{ id: "recent" }],
    [{ id: "catch-all", isCatchAll: true }, { id: "recent" }, { id: "older" }],
    "first-page", "loaded-tail", email => !email.isCatchAll,
  )
  assert.deepEqual(result.messages, [{ id: "recent" }, { id: "older" }])
  assert.equal(result.nextCursor, "loaded-tail")
})
