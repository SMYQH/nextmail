import { eq } from "drizzle-orm"
import { createDb } from "@/lib/db"
import { getUserRole } from "@/lib/auth"
import { ROLES } from "@/lib/permissions"
import { userEmailDomainAccess } from "@/lib/schema"
import { normalizeEmailDomains } from "@/lib/email-domains"

export function parseUserAllowedEmailDomains(value: string | null | undefined): string[] | null {
  if (value == null) return null

  try {
    const domains: unknown = JSON.parse(value)
    if (!Array.isArray(domains) || domains.some(domain => typeof domain !== "string")) return []
    return normalizeEmailDomains(domains.join(","))
  } catch {
    return []
  }
}

export async function getUserAllowedEmailDomains(userId: string): Promise<string[] | null> {
  const access = await createDb().query.userEmailDomainAccess.findFirst({
    where: eq(userEmailDomainAccess.userId, userId),
  })

  return parseUserAllowedEmailDomains(access?.domains)
}

export async function getAvailableEmailDomains(
  userId: string,
  configuredDomains: readonly string[],
  isEmperor?: boolean
): Promise<string[]> {
  const domains = normalizeEmailDomains(configuredDomains.join(","))
  const hasAllDomainAccess = isEmperor ?? (await getUserRole(userId)) === ROLES.EMPEROR
  if (hasAllDomainAccess) return domains

  const userAllowedDomains = await getUserAllowedEmailDomains(userId)
  if (userAllowedDomains === null) return domains

  const allowedDomains = new Set(userAllowedDomains)
  return domains.filter(domain => allowedDomains.has(domain))
}
