import test from "node:test"
import assert from "node:assert/strict"
import { MAILBOX_UPDATE_EVENT, MailboxSnapshotTracker, mailboxSnapshots, notifyMailboxUpdate } from "../app/lib/mailbox-events"

test("read and delete results invalidate older message snapshots without affecting other mailboxes", () => {
  const tracker = new MailboxSnapshotTracker()
  const beforeRead = tracker.snapshot()
  tracker.record({ emailId: "box", messageId: "a", read: true, totalDelta: 0, unreadDelta: 0, total: 2, unread: 1 })
  assert.equal(tracker.isCurrent("box", beforeRead), false)
  assert.equal(tracker.isCurrent("other", beforeRead), true)
  assert.deepEqual(tracker.reconcile("box", beforeRead, { total: 2, unread: 2 }), { total: 2, unread: 1 })

  const beforeDelete = tracker.snapshot()
  assert.equal(tracker.isCurrent("box", beforeDelete), true)
  tracker.record({ emailId: "box", messageId: "a", deleted: true, totalDelta: 0, unreadDelta: 0, total: 1, unread: 1 })
  assert.equal(tracker.isCurrent("box", beforeDelete), false)
  assert.deepEqual(tracker.reconcile("box", beforeDelete, { total: 2, unread: 1 }), { total: 1, unread: 1 })
  assert.deepEqual(tracker.reconcile("box", tracker.snapshot(), { total: 3, unread: 2 }), { total: 3, unread: 2 })
})

test("a delayed mailbox refresh preserves subsequent polls as well as a newer read", () => {
  const tracker = new MailboxSnapshotTracker()
  const refresh = tracker.snapshot()
  tracker.record({ emailId: "box", read: true, totalDelta: 0, unreadDelta: 0, total: 2, unread: 1 })
  const afterRead = tracker.snapshot()
  tracker.reconcile("box", afterRead, { total: 3, unread: 2 })
  assert.deepEqual(tracker.reconcile("box", refresh, { total: 2, unread: 2 }), { total: 3, unread: 2 })
})


test("mailbox refresh and arrival poll snapshots preserve the newer request in either completion order", () => {
  for (const reverse of [false, true]) {
    const tracker = new MailboxSnapshotTracker()
    const earlier = tracker.snapshot()
    const later = tracker.snapshot()
    if (!reverse) tracker.reconcile("box", earlier, { total: 2, unread: 2 })
    assert.deepEqual(tracker.reconcile("box", later, { total: 3, unread: 3 }), { total: 3, unread: 3 })
    assert.deepEqual(tracker.reconcile("box", earlier, { total: 2, unread: 2 }), { total: 3, unread: 3 })
    assert.equal(tracker.isCurrent("box", earlier), true)
  }
})

test("delayed read and delete responses preserve a newer mutation's authoritative counts", () => {
  for (const earlier of ["read", "deleted"] as const) {
    const tracker = new MailboxSnapshotTracker()
    const olderRequest = tracker.snapshot()
    const newerRequest = tracker.snapshot()
    tracker.record({ emailId: "box", deleted: true, totalDelta: 0, unreadDelta: 0, total: 1, unread: 0 }, newerRequest)
    assert.deepEqual(tracker.record({ emailId: "box", [earlier]: true, totalDelta: 0, unreadDelta: 0, total: 2, unread: 1 }, olderRequest), { total: 1, unread: 0, revalidate: true })
    assert.deepEqual(tracker.reconcile("box", olderRequest, { total: 2, unread: 2 }), { total: 1, unread: 0 })
  }
})

test("a delayed mutation preserves newer passive counts and requests fresh authoritative state", () => {
  const tracker = new MailboxSnapshotTracker()
  const readRequest = tracker.snapshot()
  tracker.reconcile("box", tracker.snapshot(), { total: 2, unread: 2 })
  assert.deepEqual(tracker.record({ emailId: "box", read: true, totalDelta: 0, unreadDelta: 0, total: 2, unread: 1 }, readRequest), { total: 2, unread: 2, revalidate: true })
  assert.deepEqual(tracker.reconcile("box", tracker.snapshot(), { total: 2, unread: 1 }), { total: 2, unread: 1 })
})

test("late mutation completion revalidates its mailbox without any mounted list", async t => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const target = new EventTarget()
  Object.defineProperty(globalThis, "window", { configurable: true, value: target })
  const requests: unknown[] = []
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    requests.push(input)
    return Response.json({ total: 1, unread: 1 })
  })
  try {
    const completed = new Promise<CustomEvent>(resolve => target.addEventListener(MAILBOX_UPDATE_EVENT, event => {
      const update = event as CustomEvent
      if (!update.detail.deleted && update.detail.total === 1) resolve(update)
    }))
    const mutation = mailboxSnapshots.snapshot()
    mailboxSnapshots.reconcile("page-two-mailbox", mailboxSnapshots.snapshot(), { total: 2, unread: 2 })
    notifyMailboxUpdate({ emailId: "page-two-mailbox", deleted: true, totalDelta: 0, unreadDelta: 0, total: 1, unread: 1 }, mutation)
    const update = await completed
    assert.equal(update.detail.unread, 1)
    assert.equal(fetchMock.mock.callCount(), 1)
    assert.deepEqual(requests, ["/api/emails/page-two-mailbox"])
  } finally {
    fetchMock.mock.restore()
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
    else Reflect.deleteProperty(globalThis, "window")
  }
})
