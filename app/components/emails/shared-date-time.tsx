"use client"

import React, { useEffect, useState } from "react"
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

export function SharedDateTime({
  value,
  locale,
  format = "date-time",
  initialText,
}: SharedDateTimeProps) {
  const timestamp = new Date(value instanceof Date ? value.getTime() : value).getTime()
  const [text, setText] = useState(() =>
    initialText ?? formatSharedDate(timestamp, locale, format, "UTC")
  )

  useEffect(() => {
    setText(formatSharedDate(timestamp, locale, format))
  }, [timestamp, locale, format])

  if (!Number.isFinite(timestamp)) return null

  return (
    <time dateTime={new Date(timestamp).toISOString()}>
      {text}
    </time>
  )
}
