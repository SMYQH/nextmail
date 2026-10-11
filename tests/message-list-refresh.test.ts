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
