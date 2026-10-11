export type SharedDateValue = Date | number | string
export type SharedDateFormat = "date-time" | "separate-date-time"

export function formatSharedDate(
  value: SharedDateValue,
  locale: string,
  format: SharedDateFormat = "date-time",
  timeZone?: string,
): string {
  const date = new Date(value instanceof Date ? value.getTime() : value)
  if (!Number.isFinite(date.getTime())) return ""

  const options: Intl.DateTimeFormatOptions = timeZone ? { timeZone } : {}
  if (format === "separate-date-time") {
    return `${date.toLocaleDateString(locale, options)} ${date.toLocaleTimeString(locale, options)}`
  }

  return date.toLocaleString(locale, options)
}

export function isPermanentExpiry(value: SharedDateValue): boolean {
  const date = new Date(value instanceof Date ? value.getTime() : value)
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() === 9999
}
