/**
 * Public base URL resolution for canonical, hreflang and Open Graph links.
 *
 * A deployment publishes a single public URL, so production only trusts the
 * configured value. The request host fallback exists for local development,
 * where it keeps LAN previews usable without extra configuration.
 */

export type HeaderReader = (name: string) => string | null

export function normalizeBaseUrl(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  return trimmed.replace(/\/+$/, "")
}

export function resolveSiteBaseUrl(options: {
  configured?: string | null
  isProduction: boolean
  readHeader: HeaderReader
}): string | undefined {
  const configured = normalizeBaseUrl(options.configured)
  if (configured) return configured

  // Production must never publish host-dependent canonical links.
  if (options.isProduction) return undefined

  const host = options.readHeader("x-forwarded-host")?.trim() || options.readHeader("host")?.trim()
  if (!host) return undefined

  const proto = options.readHeader("x-forwarded-proto")?.split(",")[0]?.trim() || "http"
  return `${proto}://${host.replace(/\/+$/, "")}`
}