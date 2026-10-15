import { isValidMailboxName } from "./mailbox-name"

export interface CatchAllDomainConfig {
  address: string
  enabled: boolean
  showAlways: boolean
}

export type CatchAllEmailConfig = Record<string, CatchAllDomainConfig>

export const CATCHALL_EMAIL_KEY = "CATCHALL_EMAIL"

export function normalizeEmailAddress(address: string): string {
  return address.trim().toLowerCase()
}

export function normalizeMailboxName(name: string): string {
  return name.trim().toLowerCase()
}

export function getEmailDomain(address: string): string | null {
  const normalizedAddress = normalizeEmailAddress(address)
  const separatorIndex = normalizedAddress.indexOf("@")

  if (
    separatorIndex <= 0 ||
    separatorIndex === normalizedAddress.length - 1 ||
    separatorIndex !== normalizedAddress.lastIndexOf("@")
  ) {
    return null
  }

  return normalizedAddress.slice(separatorIndex + 1)
}

export function getEmailLocalPart(address: string): string | null {
  const normalizedAddress = normalizeEmailAddress(address)
  const separatorIndex = normalizedAddress.indexOf("@")

  if (
    separatorIndex <= 0 ||
    separatorIndex === normalizedAddress.length - 1 ||
    separatorIndex !== normalizedAddress.lastIndexOf("@")
  ) {
    return null
  }

  return normalizedAddress.slice(0, separatorIndex)
}

export function parseCatchAllEmailConfig(value: string | null | undefined): CatchAllEmailConfig {
  if (!value?.trim()) return {}

  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}

    return Object.entries(parsed).reduce<CatchAllEmailConfig>((config, [domain, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return config

      const domainConfig = value as Record<string, unknown>
      if (typeof domainConfig.address !== "string") return config

      const normalizedDomain = domain.trim().toLowerCase()
      const address = normalizeEmailAddress(domainConfig.address)
      const localPart = getEmailLocalPart(address)

      if (
        !normalizedDomain ||
        getEmailDomain(address) !== normalizedDomain ||
        !localPart ||
        !isValidMailboxName(localPart)
      ) {
        return config
      }

      config[normalizedDomain] = {
        address,
        enabled: domainConfig.enabled === true,
        showAlways: domainConfig.showAlways !== false,
      }
      return config
    }, Object.create(null) as CatchAllEmailConfig)
  } catch {
    return {}
  }
}
