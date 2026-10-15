import { safeErrorMetadata } from "@/lib/safe-error"
import { PERMISSIONS } from "@/lib/permissions"
import { NextResponse } from "next/server"
import { nanoid } from "nanoid"
import { createDb } from "@/lib/db"
import { emails } from "@/lib/schema"
import { eq, and, gt, sql } from "drizzle-orm"
import { EXPIRY_OPTIONS } from "@/types/email"
import { EMAIL_CONFIG } from "@/config"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { getUserId } from "@/lib/apiKey"
import { getUserRole } from "@/lib/auth"
import { ROLES } from "@/lib/permissions"
import { normalizeEmailDomains } from "@/lib/email-domains"
import { getAvailableEmailDomains } from "@/lib/user-email-domain-access"
import { isValidMailboxName } from "@/lib/mailbox-name"


export async function POST(request: Request) {
  const db = createDb()
  const env = getCloudflareContext().env

  const userId = await getUserId(PERMISSIONS.MANAGE_EMAIL)
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const userRole = await getUserRole(userId!)

  try {
    if (userRole !== ROLES.EMPEROR) {
      const maxEmails = await env.SITE_CONFIG.get("MAX_EMAILS") || EMAIL_CONFIG.MAX_ACTIVE_EMAILS.toString()
      const activeEmailsCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(emails)
        .where(
          and(
            eq(emails.userId, userId!),
            gt(emails.expiresAt, new Date())
          )
        )
      
      if (Number(activeEmailsCount[0].count) >= Number(maxEmails)) {
        return NextResponse.json(
          { error: `已达到最大邮箱数量限制 (${maxEmails})` },
          { status: 403 }
        )
      }
    }

    const { name, expiryTime, domain } = await request.json<{ 
      name?: unknown
      expiryTime: number
      domain: string
    }>()

    if (!EXPIRY_OPTIONS.some(option => option.value === expiryTime)) {
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
    
    const emailData: typeof emails.$inferInsert = {
      address,
      createdAt: now,
      expiresAt: expires,
      userId: userId!
    }
    
    const result = await db.insert(emails)
      .values(emailData)
      .onConflictDoNothing()
      .returning({ id: emails.id, address: emails.address })
    if (!result.length) return NextResponse.json({ error: "Email address already exists" }, { status: 409 })
    
    return NextResponse.json({ 
      id: result[0].id,
      email: result[0].address 
    })
  } catch (error) {
    console.error('Failed to generate email:', safeErrorMetadata(error))
    return NextResponse.json(
      { error: "创建邮箱失败" },
      { status: 500 }
    )
  }
}
