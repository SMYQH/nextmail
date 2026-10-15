import { safeErrorMetadata } from "@/lib/safe-error"
import { PERMISSIONS } from "@/lib/permissions"
import { createDb } from "@/lib/db"
import { and, eq, gt, inArray, lt, notInArray, or, sql } from "drizzle-orm"
import { NextResponse } from "next/server"
import { catchAllMailboxes, emails, messages } from "@/lib/schema"
import { encodeCursor, decodeCursor } from "@/lib/cursor"
import { getUserId } from "@/lib/apiKey"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { CATCHALL_EMAIL_KEY, parseCatchAllEmailConfig } from "@/lib/catch-all"
import { normalizeEmailDomains } from "@/lib/email-domains"

const PAGE_SIZE = 20

export async function GET(request: Request) {
  const userId = await getUserId(PERMISSIONS.MANAGE_EMAIL)
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const { searchParams } = new URL(request.url)
    const cursor = searchParams.get('cursor')
    const domain = searchParams.get('domain')?.trim().toLowerCase()
    const db = createDb()
    const env = getCloudflareContext().env
    const [catchAllValue, domainsValue] = await Promise.all([
      env.SITE_CONFIG.get(CATCHALL_EMAIL_KEY), env.SITE_CONFIG.get("EMAIL_DOMAINS"),
    ])
    const domains = normalizeEmailDomains(domainsValue || "")
    const catchAll = Object.fromEntries(Object.entries(parseCatchAllEmailConfig(catchAllValue))
      .filter(([name]) => domains.includes(name)))
    const registrations = await db.select().from(catchAllMailboxes)
    const registeredDomains = new Set(registrations.map(row => row.domain))
    // Registered IDs survive renames even when the configuration address is stale.
    const catchAllIds = registrations.map(row => row.emailId)
    const legacy = Object.entries(catchAll).filter(([name]) => !registeredDomains.has(name)).map(([, config]) => config)
    const catchAllAddresses = legacy.map(config => config.address)
    const hidden = legacy.filter(config => !config.enabled && !config.showAlways).map(config => config.address)
    const hiddenIds = registrations.filter(row => {
      const config = catchAll[row.domain]
      return config && !config.enabled && !config.showAlways
    }).map(row => row.emailId)
    const catchAllCondition = or(
      catchAllIds.length ? inArray(emails.id, catchAllIds) : undefined,
      catchAllAddresses.length ? inArray(sql`LOWER(${emails.address})`, catchAllAddresses) : undefined,
    )
    const baseConditions = and(
      eq(emails.userId, userId),
      gt(emails.expiresAt, new Date()),
      domain ? eq(sql`LOWER(SUBSTR(${emails.address}, INSTR(${emails.address}, '@') + 1))`, domain) : undefined,
      hidden.length ? notInArray(sql`LOWER(${emails.address})`, hidden) : undefined,
      hiddenIds.length ? notInArray(emails.id, hiddenIds) : undefined,
    )
    const [count] = cursor ? [] : await db.select({ count: sql<number>`count(*)` }).from(emails).where(baseConditions)
    const conditions = [baseConditions]
    if (catchAllIds.length) conditions.push(notInArray(emails.id, catchAllIds))
    if (catchAllAddresses.length) conditions.push(notInArray(sql`LOWER(${emails.address})`, catchAllAddresses))
    if (cursor) {
      const { timestamp, id } = decodeCursor(cursor)
      conditions.push(or(
        lt(emails.createdAt, new Date(timestamp)),
        and(eq(emails.createdAt, new Date(timestamp)), lt(emails.id, id)),
      ))
    }
    const results = await db.query.emails.findMany({
      where: and(...conditions),
      orderBy: (emails, { desc }) => [desc(emails.createdAt), desc(emails.id)],
      limit: PAGE_SIZE + 1,
    })
    const pinned = !cursor && catchAllCondition
      ? await db.query.emails.findMany({
        where: and(baseConditions, catchAllCondition),
        orderBy: (emails, { asc }) => [asc(emails.address)],
      })
      : []
    const hasMore = results.length > PAGE_SIZE
    const list = [...pinned, ...results.slice(0, PAGE_SIZE)]
    const stats = new Map<string, { total: number; unread: number }>()
    for (let index = 0; index < list.length; index += 80) {
      const statistics = await db.select({
        emailId: messages.emailId,
        total: sql<number>`count(*)`,
        unread: sql<number>`sum(case when ${messages.isRead} = 0 then 1 else 0 end)`,
      }).from(messages).where(and(
        inArray(messages.emailId, list.slice(index, index + 80).map(email => email.id)),
        or(sql`${messages.type} != 'sent'`, sql`${messages.type} IS NULL`),
      )).groupBy(messages.emailId)
      for (const row of statistics) stats.set(row.emailId, row)
    }
    return NextResponse.json({
      emails: list.map(email => ({
        ...email,
        isCatchAll: catchAllIds.includes(email.id) || catchAllAddresses.includes(email.address.toLowerCase()),
        totalMessages: Number(stats.get(email.id)?.total || 0),
        unreadMessages: Number(stats.get(email.id)?.unread || 0),
      })),
      nextCursor: hasMore ? encodeCursor(results[PAGE_SIZE - 1].createdAt.getTime(), results[PAGE_SIZE - 1].id) : null,
      total: count ? Number(count.count) : undefined,
    })
  } catch (error) {
    console.error('Failed to fetch user emails:', safeErrorMetadata(error))
    return NextResponse.json({ error: "Failed to fetch emails" }, { status: 500 })
  }
}
