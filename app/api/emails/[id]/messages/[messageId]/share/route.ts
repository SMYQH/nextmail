import { safeErrorMetadata } from "@/lib/safe-error"
import { checkBasicSendPermission } from "@/lib/send-permissions"
import { PERMISSIONS } from "@/lib/permissions"
import { createDb } from "@/lib/db"
import { messageShares, messages, emails } from "@/lib/schema"
import { eq, and, desc, sql } from "drizzle-orm"
import { OWNER_LIST_PAGE_SIZE, ownerListBefore, ownerListPage, readOwnerListCursor } from "@/lib/owner-list-pagination"
import { NextResponse } from "next/server"
import { getUserId } from "@/lib/apiKey"
import { nanoid } from "nanoid"
import { parseShareExpiry } from "@/lib/share-expiry"


// 获取消息的所有分享链接
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; messageId: string }> }
) {
  const userId = await getUserId(PERMISSIONS.MANAGE_EMAIL)
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { id: emailId, messageId } = await params
  const db = createDb()

  try {
    // 验证邮箱所有权
    const email = await db.query.emails.findFirst({
      where: and(eq(emails.id, emailId), eq(emails.userId, userId))
    })

    if (!email || email.expiresAt.getTime() <= Date.now()) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
    }

    // 获取消息
    const message = await db.query.messages.findFirst({
      where: and(eq(messages.id, messageId), eq(messages.emailId, emailId))
    })

    if (!message) {
      return NextResponse.json({ error: "Message not found" }, { status: 404 })
    }
    const cursor = readOwnerListCursor(request)
    if (cursor === undefined) return NextResponse.json({ error: "Invalid cursor" }, { status: 400 })
    const createdAt = sql<number>`coalesce(${messageShares.createdAt}, 0)`
    const rows = await db.query.messageShares.findMany({
      where: and(eq(messageShares.messageId, messageId), ownerListBefore(createdAt, messageShares.id, cursor)),
      orderBy: [desc(createdAt), desc(messageShares.id)],
      limit: OWNER_LIST_PAGE_SIZE + 1,
    })
    const { items: shares, nextCursor } = ownerListPage(rows)
    const [count] = await db.select({ total: sql<number>`count(*)` }).from(messageShares).where(eq(messageShares.messageId, messageId))

    return NextResponse.json({ shares, total: Number(count.total), nextCursor })
  } catch (error) {
    console.error("Failed to fetch message shares:", safeErrorMetadata(error))
    return NextResponse.json(
      { error: "Failed to fetch shares" },
      { status: 500 }
    )
  }
}

// 创建新的消息分享链接
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; messageId: string }> }
) {
  const userId = await getUserId(PERMISSIONS.MANAGE_EMAIL)
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { id: emailId, messageId } = await params
  const db = createDb()

  try {
    // 验证邮箱所有权
    const email = await db.query.emails.findFirst({
      where: and(eq(emails.id, emailId), eq(emails.userId, userId))
    })

    if (!email || email.expiresAt.getTime() <= Date.now()) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
    }

    // 获取消息并验证
    const message = await db.query.messages.findFirst({
      where: and(eq(messages.id, messageId), eq(messages.emailId, emailId))
    })

    if (!message) {
      return NextResponse.json({ error: "Message not found" }, { status: 404 })
    }
    if (message.type === "sent" && !(await checkBasicSendPermission(userId)).canSend) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const expiresAt = parseShareExpiry(await request.json().catch(() => null))
    if (expiresAt === undefined) {
      return NextResponse.json({ error: "Invalid share expiry" }, { status: 400 })
    }

    // 生成简短的分享token (16个字符)
    const token = nanoid(16)

    // 创建分享记录
    const [share] = await db.insert(messageShares).values({
      messageId,
      token,
      expiresAt
    }).returning()

    return NextResponse.json(share, { status: 201 })
  } catch (error) {
    console.error("Failed to create message share:", safeErrorMetadata(error))
    return NextResponse.json(
      { error: "Failed to create share" },
      { status: 500 }
    )
  }
}

