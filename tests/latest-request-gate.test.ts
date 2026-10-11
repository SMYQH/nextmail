import test from "node:test"
import assert from "node:assert/strict"
import { LatestRequestGate } from "../app/lib/latest-request-gate"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

async function commitIfCurrent<T>(ticket: ReturnType<LatestRequestGate["begin"]>, response: Promise<T>, values: T[]) {
  const value = await response
  if (ticket.isCurrent()) values.push(value)
}

test("mailbox message responses from a previous selection are ignored", async () => {
  const gate = new LatestRequestGate()
  const mailboxA = deferred<string>()
  const mailboxB = deferred<string>()
  const committed: string[] = []

  const requestA = commitIfCurrent(gate.begin("mailbox:a:received"), mailboxA.promise, committed)
  const requestB = commitIfCurrent(gate.begin("mailbox:b:received"), mailboxB.promise, committed)

  mailboxB.resolve("mailbox-b-message")
  await requestB
  mailboxA.resolve("mailbox-a-message")
  await requestA

  assert.deepEqual(committed, ["mailbox-b-message"])
})

test("only the most recently started refresh can update one mailbox list", async () => {
  const gate = new LatestRequestGate()
  const olderRefresh = deferred<string>()
  const newerRefresh = deferred<string>()
  const committed: string[] = []

  const requestA = commitIfCurrent(gate.begin("mailbox:a:received"), olderRefresh.promise, committed)
  const requestB = commitIfCurrent(gate.begin("mailbox:a:received"), newerRefresh.promise, committed)

  newerRefresh.resolve("newer-list")
  await requestB
  olderRefresh.resolve("older-list")
  await requestA

  assert.deepEqual(committed, ["newer-list"])
})

test("shared message responses are ignored after selecting another message or closing the detail", async () => {
  const gate = new LatestRequestGate()
  const selectedMessage = deferred<string>()
  const nextMessage = deferred<string>()
  const closedDetail = deferred<string>()
  const committed: string[] = []

  const oldSelection = commitIfCurrent(gate.begin("share:token:message-a"), selectedMessage.promise, committed)
  const currentSelection = commitIfCurrent(gate.begin("share:token:message-b"), nextMessage.promise, committed)
  nextMessage.resolve("message-b")
  await currentSelection
  selectedMessage.resolve("message-a")
  await oldSelection

  const closedTicket = gate.begin("share:token:message-c")
  const afterClose = commitIfCurrent(closedTicket, closedDetail.promise, committed)
  gate.invalidate()
  closedDetail.resolve("message-c")
  await afterClose

  assert.deepEqual(committed, ["message-b"])
})
