import { validateWebhookUrl } from "../../app/lib/webhook-policy"

export function assertWebhookDeployment(urls: string[], allowedHosts: string) {
  const blocked = new Set<string>()
  for (const url of urls) {
    try {
      validateWebhookUrl(url, allowedHosts)
    } catch {
      try { blocked.add(new URL(url).hostname) } catch { blocked.add("(invalid saved URL)") }
    }
  }
  if (blocked.size) {
    throw new Error(`Enabled webhooks would stop delivering: ${[...blocked].join(", ")}. Configure WEBHOOK_ALLOWED_HOSTS with operator-approved public hostnames in .env.deploy or Actions secrets, or disable those webhooks before deploying. See docs/deploy.md#webhook-setup. No hosts are trusted automatically.`)
  }
}
