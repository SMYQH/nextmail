"use client"

import React, { useSyncExternalStore } from "react"
import {
  formatSharedDate,
  type SharedDateFormat,
  type SharedDateValue,
} from "@/lib/shared-date"

interface SharedDateTimeProps {
  value: SharedDateValue
  locale: string
  format?: SharedDateFormat
  initialText?: string
}

function subscribeToNoChanges() {
  return () => {}
}

export function SharedDateTime({
  value,
  locale,
  format = "date-time",
  initialText,
}: SharedDateTimeProps) {
  const timestamp = new Date(value instanceof Date ? value.getTime() : value).getTime()
  const serverText = initialText ?? formatSharedDate(timestamp, locale, format, "UTC")
  const text = useSyncExternalStore(
    subscribeToNoChanges,
    () => formatSharedDate(timestamp, locale, format),
    () => serverText,
  )

  if (!Number.isFinite(timestamp) || timestamp === 0) return null

  return (
    <time dateTime={new Date(timestamp).toISOString()}>
      {text}
    </time>
  )
}
