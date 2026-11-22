import { NextResponse } from "next/server"
import { and, eq, exists, gt, inArray, isNull, ne, or, sql } from "drizzle-orm"
import { getUserId } from "@/lib/apiKey"
import { readBulkDeleteIds } from "@/lib/bulk-delete-ids"
import { createDb } from "@/lib/db"
import { PERMISSIONS } from "@/lib/permissions"
import { safeErrorMetadata } from "@/lib/safe-error"
import { emails, messages } from "@/lib/schema"
import { checkBasicSendPermission } from "@/lib/send-permissions"

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await getUserId(PERMISSIONS.MANAGE_EMAIL)
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const messageType = new URL(request.url).searchParams.get("type") ?? "received"
  if (messageType !== "received" && messageType !== "sent") {
    return NextResponse.json({ error: "Invalid message type" }, { status: 400 })
  }
  const ids = await readBulkDeleteIds(request)
  if (!ids) return NextResponse.json({ error: "Invalid message IDs" }, { status: 400 })

  try {
    if (messageType === "sent" && !(await checkBasicSendPermission(userId)).canSend) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const db = createDb()
    const { id } = await params
    const activeOwnedMailbox = and(
      eq(emails.id, id),
      eq(emails.userId, userId),
      gt(emails.expiresAt, new Date()),
    )
    const ownedMailbox = exists(db.select({ id: emails.id }).from(emails).where(activeOwnedMailbox))
    const folder = and(
      eq(messages.emailId, id),
      messageType === "sent" ? eq(messages.type, "sent") : or(ne(messages.type, "sent"), isNull(messages.type)),
    )
    const requested = and(folder, inArray(messages.id, ids))
    const eligibleCount = db.select({ count: sql<number>`count(*)` }).from(messages).where(requested)

    // Recheck the whole selection in the DELETE. Read counts in the same transaction.
    const [deleted, [counts]] = await db.batch([
      db.delete(messages)
        .where(and(ownedMailbox, requested, sql`(${eligibleCount}) = ${ids.length}`))
        .returning({ id: messages.id }),
      db.select({
        total: sql<number>`count(*)`,
        unread: sql<number>`coalesce(sum(case when ${messages.isRead} = 0 then 1 else 0 end), 0)`,
      }).from(messages).where(and(ownedMailbox, folder)),
    ])

    if (deleted.length !== ids.length) {
      const eligible = await db.select({ id: messages.id })
        .from(emails).leftJoin(messages, requested).where(activeOwnedMailbox)
      const eligibleIds = new Set(eligible.map(message => message.id))
      const unavailableIds = eligible.length ? ids.filter(id => !eligibleIds.has(id)) : []
      return NextResponse.json({
        error: "One or more messages are unavailable or cannot be deleted",
        ...(unavailableIds.length ? { unavailableIds } : {}),
      }, { status: 403 })
    }

    return NextResponse.json({
      success: true,
      deletedIds: deleted.map(message => message.id),
      total: Number(counts.total),
      ...(messageType === "received" ? { unread: Number(counts.unread) } : {}),
    })
  } catch (error) {
    console.error("Failed to delete messages:", safeErrorMetadata(error))
    return NextResponse.json({ error: "Failed to delete messages" }, { status: 500 })
  }
}
