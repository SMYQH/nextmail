export type WebhookPolicyCode = "setupRequired" | "hostNotAllowed" | "invalidUrl"

export class WebhookPolicyError extends Error {
  constructor(public code: WebhookPolicyCode) {
    super(code)
  }
}

// This is an operator-controlled allowlist of trusted public endpoints. Never allow
// user-controlled DNS zones or wildcard hosts: DNS ownership is a trust boundary.
export function validateWebhookUrl(value: string, allowedHosts = ""): URL {
  const allowed = allowedHosts.split(",").map(entry => entry.trim().toLowerCase()).filter(Boolean)
  if (!allowed.length) throw new WebhookPolicyError("setupRequired")
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new WebhookPolicyError("invalidUrl")
  }
  const host = url.hostname.toLowerCase()
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")) {
    throw new WebhookPolicyError("invalidUrl")
  }
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(host) ||
    /(?:^|\.)(?:localhost|local|internal|invalid|test|example|onion)$/.test(host) ||
    host.endsWith(".home.arpa") || !allowed.includes(host)) {
    throw new WebhookPolicyError("hostNotAllowed")
  }
  return url
}

export async function signWebhook(secret: string, timestamp: string, body: string) {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${body}`))
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join("")
}
