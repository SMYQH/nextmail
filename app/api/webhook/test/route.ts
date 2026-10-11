import { safeErrorMetadata } from "@/lib/safe-error"
import { getUserId } from "@/lib/apiKey"
import { PERMISSIONS } from "@/lib/permissions"
import { createDb } from "@/lib/db"
import { webhooks } from "@/lib/schema"
import { eq } from "drizzle-orm"
import { callWebhook } from "@/lib/webhook"
import { WEBHOOK_CONFIG } from "@/config"
import { z } from "zod"
import { EmailMessage } from "@/lib/webhook"
import { validateWebhookUrl, WebhookPolicyError } from "@/lib/webhook-policy"


const testSchema = z.object({
  url: z.string().url()
})

export async function POST(request: Request) {
  const userId = await getUserId(PERMISSIONS.MANAGE_WEBHOOK)
  if (!userId) return Response.json({ error: "Forbidden" }, { status: 403 })
  try {
    const body = await request.json()
    const { url } = testSchema.parse(body)
    validateWebhookUrl(url, process.env.WEBHOOK_ALLOWED_HOSTS)

    const webhook = await createDb().query.webhooks.findFirst({ where: eq(webhooks.userId, userId) })
    if (!webhook?.secret || webhook.url !== url) return Response.json({ error: "saveBeforeTest" }, { status: 400 })
    await callWebhook(url, {
      event: WEBHOOK_CONFIG.EVENTS.NEW_MESSAGE,
      data: {
        emailId: "123456789",
        messageId: '987654321',
        fromAddress: "sender@nextmail.pages.dev",
        subject: "Test Email",
        content: "This is a test email.",
        html: "<p>This is a <strong>test</strong> email.</p>",
        receivedAt: "2023-03-01T12:00:00Z",
        toAddress: "recipient@nextmail.pages.dev"
      } as EmailMessage
    }, webhook.secret, process.env.WEBHOOK_ALLOWED_HOSTS || "")

    return Response.json({ success: true })
  } catch (error) {
    if (error instanceof WebhookPolicyError) return Response.json({ error: error.code }, { status: 400 })
    console.error("Failed to test webhook:", safeErrorMetadata(error))
    return Response.json(
      { error: "Failed to test webhook" },
      { status: 400 }
    )
  }
}
