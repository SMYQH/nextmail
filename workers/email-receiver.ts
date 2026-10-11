import { Env } from '../types'
import { drizzle } from 'drizzle-orm/d1'
import { messages, emails, webhooks } from '../app/lib/schema'
import { eq, sql } from 'drizzle-orm'
import PostalMime from 'postal-mime'
import { WEBHOOK_CONFIG } from '../app/config/webhook'
import { callWebhook, EmailMessage } from '../app/lib/webhook'
import { WebhookPolicyError } from '../app/lib/webhook-policy'
import { safeErrorMetadata } from '../app/lib/safe-error'

const handleEmail = async (message: ForwardableEmailMessage, env: Env) => {
  try {
    const db = drizzle(env.DB, { schema: { messages, emails, webhooks } })
    const parsedMessage = await PostalMime.parse(message.raw)
    const targetEmail = await db.query.emails.findFirst({
      where: eq(sql`LOWER(${emails.address})`, message.to.toLowerCase())
    })

    if (!targetEmail || targetEmail.expiresAt.getTime() <= Date.now()) {
      console.info("Recipient unavailable")
      return
    }

    const savedMessage = await db.insert(messages).values({
      emailId: targetEmail.id,
      fromAddress: message.from,
      toAddress: targetEmail.address,
      subject: parsedMessage.subject || '(无主题)',
      content: parsedMessage.text || '',
      html: parsedMessage.html || '',
      type: 'received',
    }).returning().get()

    try {
      const webhook = await db.query.webhooks.findFirst({
        where: eq(webhooks.userId, targetEmail.userId!)
      })

      if (webhook?.enabled) {
        await callWebhook(webhook.url, {
          event: WEBHOOK_CONFIG.EVENTS.NEW_MESSAGE,
          data: {
            emailId: targetEmail.id,
            messageId: savedMessage.id,
            fromAddress: savedMessage.fromAddress,
            subject: savedMessage.subject,
            content: savedMessage.content,
            html: savedMessage.html,
            receivedAt: savedMessage.receivedAt.toISOString(),
            toAddress: targetEmail.address
          } as EmailMessage
        }, webhook.secret || "", env.WEBHOOK_ALLOWED_HOSTS || "")
      }
    } catch (error) {
      console.error('Post-save webhook handling failed', {
        messageId: savedMessage.id,
        error: error instanceof WebhookPolicyError ? error.code : safeErrorMetadata(error).errorType,
      })
    }

    console.info("Email processed", { messageId: savedMessage.id })
  } catch (error) {
    console.error('Failed to process email:', safeErrorMetadata(error))
    message.setReject('Message could not be stored')
  }
}

const worker = {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await handleEmail(message, env)
  }
}

export default worker
