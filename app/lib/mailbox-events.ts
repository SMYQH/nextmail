export const MAILBOX_UPDATE_EVENT = "nextmail:mailbox-update"

export interface MailboxUpdate {
  emailId: string
  messageId?: string
  totalDelta: number
  unreadDelta: number
  read?: boolean
  deleted?: boolean
  revalidate?: boolean
  total?: number
  unread?: number
}

export class MailboxSnapshotTracker {
  private version = 0
  private updates = new Map<string, { version: number; mutation: number; total?: number; unread?: number }>()

  snapshot() {
    return ++this.version
  }

  record(update: MailboxUpdate, snapshot?: number) {
    const previous = this.updates.get(update.emailId)
    if (!update.read && !update.deleted) return
    const mutationRequest = snapshot ?? this.snapshot()
    const revalidate = Boolean(previous && previous.version > mutationRequest)
    const counts = revalidate && previous
      ? { total: previous.total, unread: previous.unread }
      : { total: update.total ?? previous?.total, unread: update.unread ?? previous?.unread }
    const version = ++this.version
    this.updates.set(update.emailId, {
      ...counts,
      version,
      mutation: version,
    })
    // Request order cannot establish commit order for overlapping mutations.
    return { ...counts, revalidate }
  }

  isCurrent(emailId: string, snapshot: number) {
    return (this.updates.get(emailId)?.mutation ?? 0) <= snapshot
  }

  reconcile(emailId: string, snapshot: number, counts: { total?: number; unread?: number }) {
    const update = this.updates.get(emailId)
    if (!update || update.version <= snapshot) {
      const accepted = { total: counts.total ?? update?.total, unread: counts.unread ?? update?.unread }
      this.updates.set(emailId, { ...accepted, version: snapshot, mutation: update?.mutation ?? 0 })
      return accepted
    }
    return {
      total: update?.total ?? counts.total,
      unread: update?.unread ?? counts.unread,
    }
  }
}

export const mailboxSnapshots = new MailboxSnapshotTracker()

export function notifyMailboxUpdate(update: MailboxUpdate, snapshot?: number) {
  const counts = mailboxSnapshots.record(update, snapshot)
  const detail = { ...update, ...counts }
  window.dispatchEvent(new CustomEvent<MailboxUpdate>(MAILBOX_UPDATE_EVENT, { detail }))
  if (detail.revalidate) void revalidateMailboxStatistics(update.emailId)
}

async function revalidateMailboxStatistics(emailId: string) {
  const snapshot = mailboxSnapshots.snapshot()
  try {
    const response = await fetch(`/api/emails/${encodeURIComponent(emailId)}`)
    if (!response.ok) return
    const data = await response.json() as { total?: number; unread?: number }
    if (typeof data.total !== "number" || typeof data.unread !== "number") return
    const counts = mailboxSnapshots.reconcile(emailId, snapshot, data)
    notifyMailboxUpdate({ emailId, totalDelta: 0, unreadDelta: 0, ...counts })
  } catch {
    // Regular polling and manual refresh remain available after a network failure.
  }
}
