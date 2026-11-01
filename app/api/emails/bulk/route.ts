import { NextResponse } from "next/server"
import { and, eq, gt, inArray, sql } from "drizzle-orm"
import { createDb } from "@/lib/db"
import { getUserId } from "@/lib/apiKey"
import { PERMISSIONS } from "@/lib/permissions"
import { catchAllMailboxes, emails } from "@/lib/schema"
import { CATCHALL_EMAIL_KEY, parseCatchAllEmailConfig } from "@/lib/catch-all"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { safeErrorMetadata } from "@/lib/safe-error"

const MAX_BULK_EMAIL_DELETIONS = 40
const MAX_BULK_DELETE_BODY_BYTES = 8 * 1024

function parseEmailIds(body: unknown): string[] | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null
  const record = body as Record<string, unknown>
  if (Object.keys(record).length !== 1 || !Object.hasOwn(record, "ids")) return null
  const ids = record.ids
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BULK_EMAIL_DELETIONS) return null
  if (ids.some(id => typeof id !== "string" || id.length === 0 || id.length > 128)) return null
  if (new Set(ids).size !== ids.length) return null
  return ids as string[]
}

async function parseRequestEmailIds(request: Request): Promise<string[] | null> {
  const rawContentLength = request.headers.get("content-length")
  if (rawContentLength && /^\d+$/.test(rawContentLength) && Number(rawContentLength) > MAX_BULK_DELETE_BODY_BYTES) {
    return null
  }

  if (!request.body) return null
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > MAX_BULK_DELETE_BODY_BYTES) {
        await reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(value)
    }
  } catch {
    return null
  }

  const bodyBytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  try {
    return parseEmailIds(JSON.parse(new TextDecoder().decode(bodyBytes)))
  } catch {
    return null
  }
}

export async function DELETE(request: Request) {
  const userId = await getUserId(PERMISSIONS.MANAGE_EMAIL)
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const ids = await parseRequestEmailIds(request)
  if (!ids) {
    return NextResponse.json({ error: "Invalid mailbox IDs" }, { status: 400 })
  }

  try {
    const db = createDb()
    const catchAllConfig = parseCatchAllEmailConfig(
      await getCloudflareContext().env.SITE_CONFIG.get(CATCHALL_EMAIL_KEY),
    )
    const catchAllAddresses = new Set(Object.values(catchAllConfig).map(config => config.address))

    // Legacy Catch-all mailboxes are identified through KV config until they are
    // registered in D1. Check only the requested IDs so config size cannot make
    // the SQL statement exceed its bind limit.
    const requestedEmails = await db.select({ id: emails.id, address: emails.address })
      .from(emails)
      .where(inArray(emails.id, ids))
    if (requestedEmails.some(email => catchAllAddresses.has(email.address.toLowerCase()))) {
      return NextResponse.json({ error: "One or more mailboxes are unavailable or cannot be deleted" }, { status: 403 })
    }

    const now = new Date()
    const eligible = and(
      inArray(emails.id, ids),
      eq(emails.userId, userId),
      gt(emails.expiresAt, now),
      sql`NOT EXISTS (
        SELECT 1 FROM ${catchAllMailboxes}
        WHERE ${catchAllMailboxes.emailId} = ${emails.id}
      )`,
    )
    // The count guard makes the one cascading DELETE all-or-none: ownership,
    // expiry, existence, and registered Catch-all status are rechecked in the
    // same SQLite statement that removes the rows.
    const allRequestedEligible = sql`(
      SELECT COUNT(*) FROM ${emails}
      WHERE ${eligible}
    ) = ${ids.length}`
    const deleted = await db.delete(emails)
      .where(and(eligible, allRequestedEligible))
      .returning({ id: emails.id })

    if (deleted.length !== ids.length) {
      return NextResponse.json({ error: "One or more mailboxes are unavailable or cannot be deleted" }, { status: 403 })
    }

    return NextResponse.json({ success: true, deletedIds: deleted.map(email => email.id) })
  } catch (error) {
    console.error("Failed to delete mailboxes:", safeErrorMetadata(error))
    return NextResponse.json({ error: "Failed to delete mailboxes" }, { status: 500 })
  }
}
