import { safeErrorMetadata } from "@/lib/safe-error"
import { PERMISSIONS } from "@/lib/permissions"
import { NextResponse } from "next/server"
import { createDb } from "@/lib/db"
import { catchAllMailboxes, emails, messages, messageArrivals } from "@/lib/schema"
import { eq, and, lt, or, sql, ne, isNull, gt, asc } from "drizzle-orm"
import { encodeCursor, decodeCursor, encodeArrivalCursor, decodeArrivalCursor } from "@/lib/cursor"
import { getUserId } from "@/lib/apiKey"
import { checkBasicSendPermission } from "@/lib/send-permissions"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { CATCHALL_EMAIL_KEY, parseCatchAllEmailConfig } from "@/lib/catch-all"


export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getUserId(PERMISSIONS.MANAGE_EMAIL)
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const db = createDb()
    const { id } = await params
    const email = await db.query.emails.findFirst({
      where: and(
        eq(emails.id, id),
        eq(emails.userId, userId!)
      )
    })

    if (!email || email.expiresAt.getTime() <= Date.now()) {
      return NextResponse.json(
        { error: "邮箱不存在或无权限删除" },
        { status: 403 }
      )
    }
    const registered = await db.query.catchAllMailboxes.findFirst({ where: eq(catchAllMailboxes.emailId, id) })
    if (registered) {
      return NextResponse.json({ error: "Manage Catch-all mailboxes in website settings" }, { status: 403 })
    }
    const catchAll = parseCatchAllEmailConfig(await getCloudflareContext().env.SITE_CONFIG.get(CATCHALL_EMAIL_KEY))
    if (Object.values(catchAll).some(config => config.address === email.address.toLowerCase())) {
      return NextResponse.json({ error: "Manage Catch-all mailboxes in website settings" }, { status: 403 })
    }
    await db.delete(messages)
      .where(eq(messages.emailId, id))

    await db.delete(emails)
      .where(eq(emails.id, id))

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Failed to delete email:', safeErrorMetadata(error))
    return NextResponse.json(
      { error: "删除邮箱失败" },
      { status: 500 }
    )
  }
}

const PAGE_SIZE = 20

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { searchParams } = new URL(request.url)
  const cursorStr = searchParams.get('cursor')
  const messageType = searchParams.get('type')
  const since = searchParams.get('since')

  try {
    const db = createDb()
    const { id } = await params

    const userId = await getUserId(PERMISSIONS.MANAGE_EMAIL)
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    if (messageType === 'sent') {
      const permissionResult = await checkBasicSendPermission(userId!)
      if (!permissionResult.canSend) {
        return NextResponse.json(
          { error: permissionResult.error || "您没有查看发送邮件的权限" },
          { status: 403 }
        )
      }
    }

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

    const baseConditions = and(
      eq(messages.emailId, id),
      messageType === 'sent' 
        ? eq(messages.type, "sent") 
        : or(
            ne(messages.type, "sent"),
            isNull(messages.type)
          )
    )

    const getStatistics = async () => {
      const [row] = await db.select({
        count: sql<number>`count(*)`,
        unread: sql<number>`sum(case when ${messages.isRead} = 0 then 1 else 0 end)`,
      }).from(messages).where(baseConditions)
      return { total: Number(row?.count || 0), unread: Number(row?.unread || 0) }
    }

    const orderByTime = messageType === 'sent' ? messages.sentAt : messages.receivedAt
    if (since) {
      const sequence = decodeArrivalCursor(since)
      const rows = await db.select({
        id: messages.id, emailId: messages.emailId, type: messages.type,
        fromAddress: messages.fromAddress, toAddress: messages.toAddress,
        subject: messages.subject, isRead: messages.isRead,
        receivedAt: messages.receivedAt, sentAt: messages.sentAt,
        sequence: messageArrivals.sequence,
      })
        .from(messageArrivals).innerJoin(messages, eq(messageArrivals.messageId, messages.id))
        .where(and(baseConditions, gt(messageArrivals.sequence, sequence)))
        .orderBy(asc(messageArrivals.sequence)).limit(PAGE_SIZE + 1)
      const page = rows.slice(0, PAGE_SIZE)
      const latest = page.at(-1)
      return NextResponse.json({
        messages: page.map(serializeMessage),
        ...await getStatistics(),
        latestCursor: encodeArrivalCursor(latest?.sequence ?? sequence),
        hasMore: rows.length > PAGE_SIZE,
      })
    }

    // Capture before the message snapshot; concurrent commits may replay, but cannot be skipped.
    const [watermark] = !cursorStr ? await db.select({ sequence: sql<number>`coalesce(max(${messageArrivals.sequence}), 0)` })
      .from(messageArrivals).innerJoin(messages, eq(messageArrivals.messageId, messages.id))
      .where(baseConditions) : []

    const conditions = [baseConditions]

    if (cursorStr) {
      const { timestamp, id } = decodeCursor(cursorStr)
      const orderByTime = messageType === 'sent' ? messages.sentAt : messages.receivedAt
      conditions.push(
        or(
          lt(orderByTime, new Date(timestamp)),
          and(
            eq(orderByTime, new Date(timestamp)),
            lt(messages.id, id)
          )
        )
      )
    }

    const results = await db.query.messages.findMany({
      columns: { content: false, html: false },
      where: and(...conditions),
      orderBy: (messages, { desc }) => [
        desc(orderByTime),
        desc(messages.id)
      ],
      limit: PAGE_SIZE + 1
    })
    
    const hasMore = results.length > PAGE_SIZE
    const nextCursor = hasMore 
      ? encodeCursor(
          messageType === 'sent' 
            ? results[PAGE_SIZE - 1].sentAt!.getTime()
            : results[PAGE_SIZE - 1].receivedAt.getTime(),
          results[PAGE_SIZE - 1].id
        )
      : null
    const messageList = hasMore ? results.slice(0, PAGE_SIZE) : results

    return NextResponse.json({ 
      messages: messageList.map(serializeMessage),
      latestCursor: encodeArrivalCursor(Number(watermark?.sequence || 0)),
      nextCursor,
      ...(!cursorStr ? await getStatistics() : {}),
    })
  } catch (error) {
    console.error('Failed to fetch messages:', safeErrorMetadata(error))
    return NextResponse.json(
      { error: "Failed to fetch messages" },
      { status: 500 }
    )
  }
}

function serializeMessage(msg: Omit<typeof messages.$inferSelect, "content" | "html">) {
  return {
    id: msg.id,
    from_address: msg.fromAddress,
    to_address: msg.toAddress,
    subject: msg.subject,
    sent_at: msg.sentAt.getTime(),
    received_at: msg.receivedAt.getTime(),
    is_read: msg.isRead,
  }
}
