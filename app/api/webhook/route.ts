import { safeErrorMetadata } from "@/lib/safe-error"
import { checkPermission } from "@/lib/auth"
import { PERMISSIONS } from "@/lib/permissions"
import { validateWebhookUrl, WebhookPolicyError, type WebhookPolicyCode } from "@/lib/webhook-policy"
import { auth } from "@/lib/auth"
import { createDb } from "@/lib/db"
import { webhooks } from "@/lib/schema"
import { eq, sql } from "drizzle-orm"
import { z } from "zod"


const webhookSchema = z.object({
  url: z.string().url(),
  enabled: z.boolean()
})

export async function GET() {
  if (!await checkPermission(PERMISSIONS.MANAGE_WEBHOOK)) return Response.json({ error: "Forbidden" }, { status: 403 })
  const session = await auth()

  const db = createDb()
  const webhook = await db.query.webhooks.findFirst({
    where: eq(webhooks.userId, session!.user!.id!),
    orderBy: (table, { desc }) => [desc(table.updatedAt)]
  })

  let setupError: WebhookPolicyCode | undefined
  try {
    validateWebhookUrl(webhook?.url || "https://unconfigured.invalid", process.env.WEBHOOK_ALLOWED_HOSTS)
  } catch (error) {
    if (error instanceof WebhookPolicyError && (webhook || error.code === "setupRequired")) setupError = error.code
  }
  // The signing secret never leaves the server; report only whether one exists.
  return Response.json(
    {
      enabled: webhook?.enabled ?? false,
      url: webhook?.url ?? "",
      hasSecret: Boolean(webhook?.secret),
      setupError
    },
    { headers: { "Cache-Control": "no-store" } }
  )
}

export async function POST(request: Request) {
  if (!await checkPermission(PERMISSIONS.MANAGE_WEBHOOK)) return Response.json({ error: "Forbidden" }, { status: 403 })
  const session = await auth()
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { url, enabled } = webhookSchema.parse(body)
    if (enabled) validateWebhookUrl(url, process.env.WEBHOOK_ALLOWED_HOSTS)
    
    const db = createDb()
    const now = new Date()

    // One webhook row per user: upsert on the unique user index so a second row
    // can never be created, and keep the existing signing secret.
    await db
      .insert(webhooks)
      .values({
        userId: session.user.id,
        secret: crypto.randomUUID(),
        url,
        enabled,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: webhooks.userId,
        set: {
          url,
          enabled,
          updatedAt: now,
          secret: sql`coalesce(${webhooks.secret}, excluded.secret)`,
        },
      })

    return Response.json({ success: true })
  } catch (error) {
    if (error instanceof WebhookPolicyError) return Response.json({ error: error.code }, { status: 400 })
    console.error("Failed to save webhook:", safeErrorMetadata(error))
    return Response.json(
      { error: "Invalid request" },
      { status: 400 }
    )
  }
}
