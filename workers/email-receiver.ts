import { Env } from '../types'
import { drizzle } from 'drizzle-orm/d1'
import { messages, emails, webhooks, userRoles, roles, catchAllMailboxes } from '../app/lib/schema'
import { and, eq, sql } from 'drizzle-orm'
import PostalMime from 'postal-mime'
import { WEBHOOK_CONFIG } from '../app/config/webhook'
import { callWebhook, EmailMessage } from '../app/lib/webhook'
import { WebhookPolicyError } from '../app/lib/webhook-policy'
import { safeErrorMetadata } from '../app/lib/safe-error'
import { CATCHALL_EMAIL_KEY, getEmailDomain, normalizeEmailAddress, parseCatchAllEmailConfig } from '../app/lib/catch-all'
import { buildDeliveryKey } from '../app/lib/delivery-key'
import { normalizeEmailDomains } from '../app/lib/email-domains'
import { ROLES } from '../app/lib/permissions'

const handleEmail = async (message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) => {
  try {
    const db = drizzle(env.DB, { schema: { messages, emails, webhooks } })
    const recipient = normalizeEmailAddress(message.to)
    let targetEmail = await db.query.emails.findFirst({
      where: eq(sql`LOWER(${emails.address})`, recipient)
    })

    if (!targetEmail) {
      try {
        const [value, domainValue] = await Promise.all([
          env.SITE_CONFIG.get(CATCHALL_EMAIL_KEY),
          env.SITE_CONFIG.get('EMAIL_DOMAINS'),
        ])
        const domain = getEmailDomain(recipient)
        const config = domain ? parseCatchAllEmailConfig(value)[domain] : undefined
        if (!domain || !normalizeEmailDomains(domainValue || '').includes(domain) || !config?.enabled) {
          console.info('Catch-all unavailable')
          return
        }
        // Resolve the registry and target in one snapshot, including during legacy mailbox upgrades.
        // Two indexed lookups replace the OR that mixed a join column with an address
        // comparison, so an unknown recipient no longer scans the whole mailbox table.
        const registeredId = sql`(select ${catchAllMailboxes.emailId} from ${catchAllMailboxes} where ${catchAllMailboxes.domain} = ${domain})`
        const legacyId = sql`(select ${emails.id} from ${emails} where lower(${emails.address}) = ${config.address})`
        const [target] = await db.select({ email: emails })
          .from(emails)
          .innerJoin(userRoles, eq(emails.userId, userRoles.userId))
          .innerJoin(roles, eq(userRoles.roleId, roles.id))
          .where(and(
            eq(roles.name, ROLES.EMPEROR),
            eq(emails.id, sql`coalesce(${registeredId}, ${legacyId})`),
          ))
          .limit(1)
        targetEmail = target?.email
      } catch (error) {
        console.error('Catch-all lookup failed:', safeErrorMetadata(error))
        throw error
      }
    }

    if (!targetEmail || targetEmail.expiresAt.getTime() <= Date.now()) {
      console.info("Recipient unavailable")
      return
    }

    // The raw stream is single-use, so it is buffered once and the buffered copy
    // is used for both the delivery key and the parse.
    const rawBytes = new Uint8Array(await new Response(message.raw).arrayBuffer())
    const parsedMessage = await PostalMime.parse(rawBytes)
    const deliveryKey = await buildDeliveryKey({
      headers: parsedMessage.headers,
      recipient: message.to,
      raw: rawBytes,
    })

    // A redelivered message must not be stored twice, so the insert ignores a
    // conflict on the delivery key.
    const savedMessage = await db.insert(messages).values({
      emailId: targetEmail.id,
      fromAddress: parsedMessage.from?.address || message.from,
      toAddress: message.to,
      subject: parsedMessage.subject || '(无主题)',
      content: parsedMessage.text || '',
      html: parsedMessage.html || '',
      type: 'received',
      deliveryKey,
    }).onConflictDoNothing({ target: messages.deliveryKey }).returning().get()

    if (!savedMessage) {
      console.info("Duplicate delivery ignored", { mailbox: targetEmail.id })
      return
    }

    // The webhook delivery runs after the message is stored. A slow endpoint must not
    // delay or fail mail acceptance, and a delivery failure never affects the stored
    // message, so the delivery is deferred with the worker execution context.
    const delivery = (async () => {
      try {
        const webhook = targetEmail.userId ? await db.query.webhooks.findFirst({
          where: eq(webhooks.userId, targetEmail.userId!),
          orderBy: (table, { desc }) => [desc(table.updatedAt)]
        }) : undefined

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
              toAddress: message.to
            } as EmailMessage
          }, webhook.secret || "", env.WEBHOOK_ALLOWED_HOSTS || "")
        }
      } catch (error) {
        console.error('Post-save webhook handling failed', {
          messageId: savedMessage.id,
          error: error instanceof WebhookPolicyError ? error.code : safeErrorMetadata(error).errorType,
        })
      }
    })()

    ctx.waitUntil(delivery)

    console.info("Email processed", { messageId: savedMessage.id })
  } catch (error) {
    console.error('Failed to process email:', safeErrorMetadata(error))
    message.setReject('Message could not be stored')
  }
}

const worker = {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleEmail(message, env, ctx)
  }
}

export default worker
