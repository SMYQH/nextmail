import { normalizeEmailDomains } from "@/lib/email-domains"
import { getEmailDomain } from "@/lib/catch-all"

export const RESEND_CONFIG_KEY = "RESEND_CONFIG"

export interface ResendDomainConfig {
  enabled: boolean
  apiKey: string
}

export type ResendConfig = Record<string, ResendDomainConfig>

interface SiteConfigReader {
  get(key: string): Promise<string | null>
}

export interface EmailRoleLimits {
  duke?: number
  knight?: number
}

function parseResendConfig(value: string | null): ResendConfig {
  if (value === null) return {}

  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}

    return Object.entries(parsed).reduce<ResendConfig>((config, [domain, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return config

      const entry = value as Record<string, unknown>
      if (typeof entry.enabled !== "boolean" || typeof entry.apiKey !== "string") return config

      const normalizedDomain = domain.trim().toLowerCase()
      if (!normalizedDomain) return config

      config[normalizedDomain] = {
        enabled: entry.enabled,
        apiKey: entry.apiKey,
      }
      return config
    }, {})
  } catch {
    return {}
  }
}

export function parseEmailRoleLimits(value: string | null): EmailRoleLimits {
  if (!value) return {}

  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}

    const limits = parsed as Record<string, unknown>
    return ["duke", "knight"].reduce<EmailRoleLimits>((result, role) => {
      const limit = limits[role]
      if (typeof limit === "number" && Number.isInteger(limit) && limit >= -1) {
        result[role as keyof EmailRoleLimits] = limit
      }
      return result
    }, {})
  } catch {
    return {}
  }
}

export async function loadResendConfig(siteConfig: SiteConfigReader): Promise<{
  configuredDomains: string[]
  config: ResendConfig
}> {
  const [emailDomains, storedConfig, legacyEnabled, legacyApiKey] = await Promise.all([
    siteConfig.get("EMAIL_DOMAINS"),
    siteConfig.get(RESEND_CONFIG_KEY),
    siteConfig.get("EMAIL_SERVICE_ENABLED"),
    siteConfig.get("RESEND_API_KEY"),
  ])

  const configuredDomains = normalizeEmailDomains(emailDomains ?? "")

  if (storedConfig !== null) {
    return {
      configuredDomains,
      config: parseResendConfig(storedConfig),
    }
  }

  // Keep existing installations working until they save the per-domain form.
  const legacyConfig = {
    enabled: legacyEnabled === "true",
    apiKey: legacyApiKey ?? "",
  }
  const config = configuredDomains.reduce<ResendConfig>((result, domain) => {
    result[domain] = legacyConfig
    return result
  }, {})

  // The old global setting applied to every mailbox, including domains that
  // have since been removed from EMAIL_DOMAINS.
  config["*"] = legacyConfig

  return { configuredDomains, config }
}

export function getResendConfigForAddress(config: ResendConfig, address: string): ResendDomainConfig | undefined {
  const domain = getEmailDomain(address)
  return domain ? config[domain] ?? config["*"] : undefined
}

export function getEnabledResendDomains(config: ResendConfig): string[] {
  return Object.entries(config)
    .filter(([, domainConfig]) => domainConfig.enabled && Boolean(domainConfig.apiKey.trim()))
    .map(([domain]) => domain)
}
