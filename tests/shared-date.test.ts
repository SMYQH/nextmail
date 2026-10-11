import test from "node:test"
import assert from "node:assert/strict"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { SharedDateTime } from "../app/components/emails/shared-date-time"
import { formatSharedDate, isPermanentExpiry } from "../app/lib/shared-date"

const date = new Date("2024-01-01T01:30:00.000Z")

test("shared date component renders the exact server-provided fallback during SSR", () => {
  const serverText = formatSharedDate(date, "en-US", "date-time", "UTC")
  const markup = renderToStaticMarkup(createElement(SharedDateTime, {
    value: date,
    locale: "en-US",
    initialText: serverText,
  }))

  assert.ok(markup.includes(`>${serverText}</time>`))
  assert.ok(markup.includes('dateTime="2024-01-01T01:30:00.000Z"'))
})

test("shared date formatting respects the current locale and viewer time zone", () => {
  const utcText = formatSharedDate(date, "en-US", "date-time", "UTC")
  const localText = formatSharedDate(date, "en-US", "date-time", "America/Los_Angeles")
  const chineseText = formatSharedDate(date, "zh-CN", "date-time", "Asia/Shanghai")

  assert.equal(utcText, "1/1/2024, 1:30:00 AM")
  assert.equal(localText, "12/31/2023, 5:30:00 PM")
  assert.notEqual(chineseText, utcText)
})

test("separate date and time formatting preserves the shared-mailbox expiry layout", () => {
  assert.equal(
    formatSharedDate(date, "en-US", "separate-date-time", "UTC"),
    "1/1/2024 1:30:00 AM",
  )
})

test("permanent expiry uses the UTC sentinel year across local time zones", () => {
  const expiry = new Date("9999-01-01T00:00:00.000Z")

  assert.equal(formatSharedDate(expiry, "en-US", "date-time", "America/Los_Angeles").startsWith("12/31/9998"), true)
  assert.equal(isPermanentExpiry(expiry), true)
  assert.equal(isPermanentExpiry(new Date("9998-12-31T23:59:59.000Z")), false)
})
