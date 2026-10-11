import { WEBHOOK_CONFIG } from "../config/webhook"
import { validateWebhookUrl, signWebhook } from "./webhook-policy"

export interface EmailMessage {
  emailId: string
  messageId: string
  fromAddress: string
  subject: string
  content: string
  html: string
  receivedAt: string
  toAddress: string
}

export interface WebhookPayload {
  event: typeof WEBHOOK_CONFIG.EVENTS[keyof typeof WEBHOOK_CONFIG.EVENTS]
  data: EmailMessage
}

export async function callWebhook(url: string, payload: WebhookPayload, secret: string, allowedHosts: string) {
  const target = validateWebhookUrl(url, allowedHosts)
  if (!secret) throw new Error("Webhook signing secret is missing; save the webhook configuration again")
  const body = JSON.stringify(payload.data)
  let lastError: Error | null = null
  
  for (let i = 0; i < WEBHOOK_CONFIG.MAX_RETRIES; i++) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_CONFIG.TIMEOUT)
    try {
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const response = await fetch(target, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Event": payload.event,
          "X-Webhook-Timestamp": timestamp,
          "X-Webhook-Signature": `sha256=${await signWebhook(secret, timestamp, body)}`,
        },
        body,
        signal: controller.signal,
        redirect: "error",
      })

      await response.body?.cancel()

      if (response.ok) {
        return true
      }

      lastError = new Error(`HTTP error! status: ${response.status}`)
    } catch (error) {
      lastError = error as Error
    } finally {
      clearTimeout(timeoutId)
    }
    if (i < WEBHOOK_CONFIG.MAX_RETRIES - 1) await new Promise(resolve => setTimeout(resolve, WEBHOOK_CONFIG.RETRY_DELAY))
  }

  throw lastError
}
