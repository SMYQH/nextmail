import test from "node:test"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { validateWebhookUrl, signWebhook } from "../app/lib/webhook-policy"
import { callWebhook } from "../app/lib/webhook"

test("webhooks require an exact trusted HTTPS hostname", () => {
  const allowed = "hooks.example.com"
  assert.equal(validateWebhookUrl("https://hooks.example.com/event", allowed).hostname, allowed)
  for (const url of ["http://hooks.example.com", "https://hooks.example.com:8080", "https://user:pass@hooks.example.com", "https://hooks.example.com.attacker.com", "https://127.0.0.1", "https://2130706433", "https://[::1]", "https://metadata.internal", "https://localhost", "https://hooks.example.com#fragment"]) {
    assert.throws(() => validateWebhookUrl(url, `${allowed},127.0.0.1,localhost,metadata.internal`))
  }
  assert.throws(() => validateWebhookUrl("https://hooks.example.com"))
})

test("signatures authenticate the timestamp and exact request bytes", async () => {
  const body = '{"content":"hello"}'
  const signature = await signWebhook("test-secret", "123", body)
  assert.equal(signature, createHmac("sha256", "test-secret").update(`123.${body}`).digest("hex"))
  assert.notEqual(signature, await signWebhook("test-secret", "124", body))
})

test("delivery signs payloads, disables redirects and sets a timeout", async t => {
  let called = false
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    called = true
    assert.equal(options.redirect, "error")
    assert.ok(options.signal)
    const headers = new Headers(options.headers)
    assert.equal(headers.get("X-Webhook-Signature"), `sha256=${await signWebhook("secret", headers.get("X-Webhook-Timestamp")!, options.body as string)}`)
    return new Response(null, { status: 204 })
  })
  await callWebhook("https://hooks.example.com", { event: "new_message", data: { emailId: "e", messageId: "m", fromAddress: "a", toAddress: "b", subject: "s", content: "c", html: "", receivedAt: "now" } }, "secret", "hooks.example.com")
  assert.ok(called)
})
