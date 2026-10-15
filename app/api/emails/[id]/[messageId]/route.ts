import { safeErrorMetadata } from "@/lib/safe-error"
import { checkBasicSendPermission } from "@/lib/send-permissions"
import { PERMISSIONS } from "@/lib/permissions"
import { NextResponse } from "next/server"
import { createDb } from "@/lib/db"
import { messages, emails } from "@/lib/schema"
import { and, eq, isNull, ne, or, sql } from "drizzle-orm"
import { getUserId } from "@/lib/apiKey"

export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ id: string; messageId: string }> }
) {
  const userId = await getUserId(PERMISSIONS.MANAGE_EMAIL)
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const db = createDb()
    const { id, messageId } = await params
    const email = await db.query.emails.findFirst({
      where: and(
          eq(emails.id, id),
          eq(emails.userId, userId!)
      )
    })

    if (!email || email.expiresAt.getTime() <= Date.now()) {
      return NextResponse.json(
          { error: "Email not found or no permission to view" },
          { status: 403 }
      )
    }

    const message = await db.query.messages.findFirst({
      where: and(
          eq(messages.emailId, id),
          eq(messages.id, messageId)
      )
    })

    if(!message) {
      return NextResponse.json(
          { error: "Message not found or already deleted" },
          { status: 404 }
      )
    }
    if (message.type === "sent" && !(await checkBasicSendPermission(userId)).canSend) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    await db.delete(messages)
        .where(eq(messages.id, messageId))

    const [statistics] = message.type !== "sent" ? await db.select({
      total: sql<number>`count(*)`,
      unread: sql<number>`coalesce(sum(case when ${messages.isRead} = 0 then 1 else 0 end), 0)`,
    }).from(messages).where(and(
      eq(messages.emailId, id), or(ne(messages.type, "sent"), isNull(messages.type)),
    )) : []

    return NextResponse.json({
      success: true,
      ...(statistics ? { total: Number(statistics.total), unread: Number(statistics.unread) } : {}),
    })
  } catch (error) {
    console.error('Failed to delete email:', safeErrorMetadata(error))
    return NextResponse.json(
        { error: "Failed to delete message" },
        { status: 500 }
    )
  }
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; messageId: string }> }) {
  try {
    const { id, messageId } = await params
    const db = createDb()
    const userId = await getUserId(PERMISSIONS.MANAGE_EMAIL)
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const email = await db.query.emails.findFirst({
      where: and(
        eq(emails.id, id),
        eq(emails.userId, userId!)
      )
    })

    if (!email || email.expiresAt.getTime() <= Date.now()) {
      return NextResponse.json(
        { error: "无权限查看" },
        { status: 403 }
      )
    }

    const message = await db.query.messages.findFirst({
      where: and(
        eq(messages.id, messageId),
        eq(messages.emailId, id)
      )
    })
    
    if (!message) {
      return NextResponse.json(
        { error: "Message not found" },
        { status: 404 }
      )
    }
    if (message.type === "sent" && !(await checkBasicSendPermission(userId)).canSend) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }
    
    const marked = message.type !== "sent" && !message.isRead
      ? await db.update(messages).set({ isRead: true })
        .where(and(eq(messages.id, messageId), eq(messages.emailId, id), eq(messages.isRead, false)))
        .returning({ id: messages.id })
      : []

    const [statistics] = message.type !== "sent" ? await db.select({
      total: sql<number>`count(*)`,
      unread: sql<number>`coalesce(sum(case when ${messages.isRead} = 0 then 1 else 0 end), 0)`,
    }).from(messages).where(and(
      eq(messages.emailId, id), or(ne(messages.type, "sent"), isNull(messages.type)),
    )) : []

    return NextResponse.json({
      wasUnread: marked.length > 0,
      ...(statistics ? { total: Number(statistics.total), unread: Number(statistics.unread) } : {}),
      message: {
        id: message.id,
        from_address: message.fromAddress,
        to_address: message.toAddress,
        subject: message.subject,
        content: message.content,
        html: message.html,
        received_at: message.receivedAt.getTime(),
        sent_at: message.type === "sent" ? message.sentAt.getTime() : undefined,
        type: message.type as 'received' | 'sent',
        is_read: message.type !== "sent" ? true : message.isRead
      }
    })
  } catch (error) {
    console.error('Failed to fetch message:', safeErrorMetadata(error))
    return NextResponse.json(
      { error: "Failed to fetch message" },
      { status: 500 }
    )
  }
}
