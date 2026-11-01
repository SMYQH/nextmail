import { safeErrorMetadata } from "@/lib/safe-error"
import { PERMISSIONS } from "@/lib/permissions"
import { NextResponse } from "next/server"
import { nanoid } from "nanoid"
import { createDb } from "@/lib/db"
import { emails } from "@/lib/schema"
import { eq, and, gt, or, sql } from "drizzle-orm"
import { EXPIRY_OPTIONS } from "@/types/email"
import { EMAIL_CONFIG } from "@/config"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { getUserId } from "@/lib/apiKey"
import { getUserRole } from "@/lib/auth"
import { ROLES } from "@/lib/permissions"
import { normalizeEmailDomains } from "@/lib/email-domains"
import { getAvailableEmailDomains } from "@/lib/user-email-domain-access"
import { isValidMailboxName } from "@/lib/mailbox-name"
import { parsePositiveSafeInteger } from "@/lib/max-emails"
import { INSERT_MAILBOX_WITH_LIMIT_SQL } from "@/lib/database-statements"


export async function POST(request: Request) {
  const db = createDb()
  const env = getCloudflareContext().env

  const userId = await getUserId(PERMISSIONS.MANAGE_EMAIL)
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const userRole = await getUserRole(userId!)
  let maxEmails = 0

  try {
    if (userRole !== ROLES.EMPEROR) {
      const storedMaxEmails = await env.SITE_CONFIG.get("MAX_EMAILS")
      maxEmails = parsePositiveSafeInteger(storedMaxEmails) ?? EMAIL_CONFIG.MAX_ACTIVE_EMAILS
      const activeEmailsCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(emails)
        .where(
          and(
            eq(emails.userId, userId!),
            gt(emails.expiresAt, new Date())
          )
        )
      
      if (Number(activeEmailsCount[0].count) >= maxEmails) {
        return NextResponse.json(
          { error: `已达到最大邮箱数量限制 (${maxEmails})` },
          { status: 403 }
        )
      }
    }

    const body = await request.json().catch(() => null) as {
      name?: unknown
      expiryTime?: unknown
      domain?: unknown
    } | null
    if (!body || typeof body !== "object") {
      return NextResponse.json(
        { error: "无效的请求格式" },
        { status: 400 }
      )
    }
    const { name, expiryTime, domain } = body

    if (typeof expiryTime !== "number" || !EXPIRY_OPTIONS.some(option => option.value === expiryTime)) {
      return NextResponse.json(
        { error: "无效的过期时间" },
        { status: 400 }
      )
    }

    const domainString = await env.SITE_CONFIG.get("EMAIL_DOMAINS")
    const domains = normalizeEmailDomains(domainString || "")
    if (!domains.length) {
      return NextResponse.json({ error: "Email domains are not configured" }, { status: 503 })
    }
    const normalizedDomain = typeof domain === "string" ? domain.trim().toLowerCase() : ""

    if (!domains.includes(normalizedDomain)) {
      return NextResponse.json(
        { error: "无效的域名" },
        { status: 400 }
      )
    }

    if (name !== undefined && typeof name !== "string") {
      return NextResponse.json({ error: "Invalid email prefix" }, { status: 400 })
    }
    const mailboxName = typeof name === "string" ? name.trim() : ""
    if (mailboxName && !isValidMailboxName(mailboxName)) {
      return NextResponse.json({ error: "Invalid email prefix" }, { status: 400 })
    }

    const availableDomains = await getAvailableEmailDomains(userId, domains, userRole === ROLES.EMPEROR)
    if (!availableDomains.includes(normalizedDomain)) {
      return NextResponse.json(
        { error: "Email domain is not available to this user" },
        { status: 403 }
      )
    }

    const address = `${mailboxName || nanoid(8)}@${normalizedDomain}`.toLowerCase()
    const existingEmail = await db.query.emails.findFirst({
      where: eq(sql`LOWER(${emails.address})`, address.toLowerCase())
    })

    if (existingEmail) {
      return NextResponse.json(
        { error: "该邮箱地址已被使用" },
        { status: 409 }
      )
    }

    const now = new Date()
    const expires = expiryTime === 0
      ? new Date('9999-01-01T00:00:00.000Z')
      : new Date(now.getTime() + expiryTime)
    const id = crypto.randomUUID()

    const result = await env.DB.prepare(INSERT_MAILBOX_WITH_LIMIT_SQL)
      .bind(
        id,
        address,
        userId!,
        now.getTime(),
        expires.getTime(),
        maxEmails,
        userId!,
        now.getTime(),
        maxEmails,
      )
      .first<{ id: string; address: string }>()
    if (!result) {
      const concurrentConflict = await db.query.emails.findFirst({
        where: or(eq(emails.id, id), eq(sql`LOWER(${emails.address})`, address)),
      })
      if (concurrentConflict) {
        return NextResponse.json({ error: "Email address already exists" }, { status: 409 })
      }
      if (userRole !== ROLES.EMPEROR) {
        return NextResponse.json(
          { error: `已达到最大邮箱数量限制 (${maxEmails})` },
          { status: 403 },
        )
      }
      return NextResponse.json({ error: "Email address already exists" }, { status: 409 })
    }

    return NextResponse.json({
      id: result.id,
      email: result.address,
    })
  } catch (error) {
    console.error('Failed to generate email:', safeErrorMetadata(error))
    return NextResponse.json(
      { error: "创建邮箱失败" },
      { status: 500 }
    )
  }
}
