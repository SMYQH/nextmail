import test from "node:test"
import assert from "node:assert/strict"
import { normalizeBaseUrl, resolveSiteBaseUrl } from "../app/lib/site-base-url"

function headerReader(headers: Record<string, string>) {
  return (name: string) => headers[name.toLowerCase()] ?? null
}

test("the configured public URL is the only production source", () => {
  const baseUrl = resolveSiteBaseUrl({
    configured: "https://mail.example.com/",
    isProduction: true,
    readHeader: headerReader({ host: "internal.workers.dev" }),
  })

  assert.equal(baseUrl, "https://mail.example.com")
})

test("production without a configured URL publishes no canonical base", () => {
  const baseUrl = resolveSiteBaseUrl({
    configured: "   ",
    isProduction: true,
    readHeader: headerReader({ host: "mail.example.com", "x-forwarded-proto": "https" }),
  })

  assert.equal(baseUrl, undefined)
})

test("production ignores the request host", () => {
  const baseUrl = resolveSiteBaseUrl({
    isProduction: true,
    readHeader: headerReader({ host: "mail.example.com", "x-forwarded-host": "other.example.com" }),
  })

  assert.equal(baseUrl, undefined)
})

test("development falls back to the request host", () => {
  const baseUrl = resolveSiteBaseUrl({
    isProduction: false,
    readHeader: headerReader({ host: "localhost:3000" }),
  })

  assert.equal(baseUrl, "http://localhost:3000")
})

test("development honours forwarded host and protocol", () => {
  const baseUrl = resolveSiteBaseUrl({
    isProduction: false,
    readHeader: headerReader({
      host: "127.0.0.1:3000",
      "x-forwarded-host": "mail.example.com",
      "x-forwarded-proto": "https, http",
    }),
  })

  assert.equal(baseUrl, "https://mail.example.com")
})

test("development without a host has no canonical base", () => {
  const baseUrl = resolveSiteBaseUrl({
    isProduction: false,
    readHeader: headerReader({}),
  })

  assert.equal(baseUrl, undefined)
})

test("base URLs lose trailing slashes and blank values", () => {
  assert.equal(normalizeBaseUrl("https://mail.example.com///"), "https://mail.example.com")
  assert.equal(normalizeBaseUrl("  https://mail.example.com  "), "https://mail.example.com")
  assert.equal(normalizeBaseUrl("   "), undefined)
  assert.equal(normalizeBaseUrl(undefined), undefined)
})