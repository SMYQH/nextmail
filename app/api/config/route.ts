import { PERMISSIONS, ROLES } from "@/lib/permissions"
import type { Role } from "@/lib/permissions"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { EMAIL_CONFIG } from "@/config"
import { checkPermission } from "@/lib/auth"
import { getUserId } from "@/lib/apiKey"
import { safeErrorMetadata } from "@/lib/safe-error"
import { createDb } from "@/lib/db"
import { catchAllMailboxes, emails } from "@/lib/schema"
import { eq, sql } from "drizzle-orm"
import { normalizeEmailDomains } from "@/lib/email-domains"
import { getAvailableEmailDomains } from "@/lib/user-email-domain-access"
import { isValidMailboxName } from "@/lib/mailbox-name"
import {
  CATCHALL_EMAIL_KEY,
  getEmailLocalPart,
  normalizeEmailAddress,
  normalizeMailboxName,
  parseCatchAllEmailConfig,
} from "@/lib/catch-all"
import type { CatchAllEmailConfig } from "@/lib/catch-all"

type TurnstileConfig = {
  enabled: boolean
  siteKey: string
  secretKey: string
}

type CatchAllRequest = {
  domains?: unknown
}

type ConfigRequest = {
  defaultRole: Exclude<Role, typeof ROLES.EMPEROR>
  emailDomains: string
  adminContact: string
  maxEmails: string
  catchAll?: CatchAllRequest
  turnstile?: TurnstileConfig
}

type CatchAllDomainSettings = {
  enabled: boolean
  showAlways: boolean
  mailboxName: string
}

type CatchAllMailboxPlan = {
  domain: string
  emailId: string
  address: string
  currentEmail: typeof emails.$inferSelect | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

async function findEmailByAddress(db: ReturnType<typeof createDb>, address: string) {
  return db.query.emails.findFirst({
    where: eq(sql`LOWER(${emails.address})`, normalizeEmailAddress(address)),
  })
}

export async function GET() {
  const env = getCloudflareContext().env
  const canManageConfig = await checkPermission(PERMISSIONS.MANAGE_CONFIG)

  const [defaultRole, emailDomains, adminContact, maxEmails] = await Promise.all([
    env.SITE_CONFIG.get("DEFAULT_ROLE"),
    env.SITE_CONFIG.get("EMAIL_DOMAINS"),
    env.SITE_CONFIG.get("ADMIN_CONTACT"),
    env.SITE_CONFIG.get("MAX_EMAILS"),
  ])

  const configuredDomains = normalizeEmailDomains(emailDomains || "")
  const userId = await getUserId()
  const response: Record<string, unknown> = {
    defaultRole: defaultRole || ROLES.CIVILIAN,
    emailDomains: configuredDomains.join(","),
    adminContact: adminContact || "",
    maxEmails: maxEmails || EMAIL_CONFIG.MAX_ACTIVE_EMAILS.toString(),
    ...(userId
      ? { availableEmailDomains: await getAvailableEmailDomains(userId, configuredDomains) }
      : {}),
  }

  // Catch-all and Turnstile settings are privileged configuration. Do not read or
  // return them for callers without the site configuration permission.
  if (!canManageConfig || !userId) return Response.json(response)

  const [turnstileEnabled, turnstileSiteKey, turnstileSecretKey, catchAllValue] = await Promise.all([
    env.SITE_CONFIG.get("TURNSTILE_ENABLED"),
    env.SITE_CONFIG.get("TURNSTILE_SITE_KEY"),
    env.SITE_CONFIG.get("TURNSTILE_SECRET_KEY"),
    env.SITE_CONFIG.get(CATCHALL_EMAIL_KEY),
  ])

  const savedCatchAllConfig = parseCatchAllEmailConfig(catchAllValue)
  const catchAllDomains = configuredDomains.reduce<Record<string, CatchAllDomainSettings>>((config, domain) => {
    const domainConfig = savedCatchAllConfig[domain]
    config[domain] = {
      enabled: domainConfig?.enabled ?? false,
      showAlways: domainConfig?.showAlways ?? true,
      mailboxName: domainConfig ? getEmailLocalPart(domainConfig.address) ?? "" : "",
    }
    return config
  }, Object.create(null) as Record<string, CatchAllDomainSettings>)

  return Response.json({
    ...response,
    turnstile: {
      enabled: turnstileEnabled === "true",
      siteKey: turnstileSiteKey || "",
      secretKey: turnstileSecretKey || "",
    },
    catchAll: { domains: catchAllDomains },
  })
}

export async function POST(request: Request) {
  const canAccess = await checkPermission(PERMISSIONS.MANAGE_CONFIG)

  if (!canAccess) {
    return Response.json({ error: "权限不足" }, { status: 403 })
  }

  const userId = await getUserId()
  if (!userId) {
    return Response.json({ error: "未登录" }, { status: 401 })
  }

  let body: ConfigRequest
  try {
    const parsedBody: unknown = await request.json()
    if (!isRecord(parsedBody)) {
      return Response.json({ error: "无效的请求数据" }, { status: 400 })
    }
    body = parsedBody as ConfigRequest
  } catch {
    return Response.json({ error: "无效的请求数据" }, { status: 400 })
  }

  const { defaultRole, emailDomains, adminContact, maxEmails, catchAll, turnstile } = body

  if (![ROLES.DUKE, ROLES.KNIGHT, ROLES.CIVILIAN].includes(defaultRole)) {
    return Response.json({ error: "无效的角色" }, { status: 400 })
  }

  const domains = typeof emailDomains === "string" ? normalizeEmailDomains(emailDomains) : []
  if (!domains.length) return Response.json({ error: "Invalid email domains" }, { status: 400 })
  if (typeof adminContact !== "string" || typeof maxEmails !== "string") {
    return Response.json({ error: "无效的请求数据" }, { status: 400 })
  }

  const turnstileConfig = turnstile ?? {
    enabled: false,
    siteKey: "",
    secretKey: "",
  }

  if (
    typeof turnstileConfig.enabled !== "boolean" ||
    typeof turnstileConfig.siteKey !== "string" ||
    typeof turnstileConfig.secretKey !== "string"
  ) {
    return Response.json({ error: "无效的 Turnstile 配置" }, { status: 400 })
  }

  if (turnstileConfig.enabled && (!turnstileConfig.siteKey || !turnstileConfig.secretKey)) {
    return Response.json({ error: "Turnstile 启用时需要提供 Site Key 和 Secret Key" }, { status: 400 })
  }

  const env = getCloudflareContext().env
  let normalizedCatchAllConfig: CatchAllEmailConfig | undefined

  // Legacy config clients omit catchAll. In that case, retain the current KV
  // value and only update the settings they know about.
  if (catchAll !== undefined) {
    if (!isRecord(catchAll) || !isRecord(catchAll.domains)) {
      return Response.json({ error: "无效的 Catch-all 邮箱配置" }, { status: 400 })
    }

    const submittedDomainSettings = new Map<string, unknown>()
    for (const [rawDomain, settings] of Object.entries(catchAll.domains)) {
      const domain = rawDomain.trim().toLowerCase()
      if (!domains.includes(domain) || submittedDomainSettings.has(domain)) {
        return Response.json({ error: `无效的 Catch-all 域名配置: ${rawDomain}` }, { status: 400 })
      }
      submittedDomainSettings.set(domain, settings)
    }

    if (domains.some(domain => !submittedDomainSettings.has(domain))) {
      return Response.json({ error: "Catch-all 配置必须包含所有邮箱域名" }, { status: 400 })
    }

    const currentCatchAllConfig = parseCatchAllEmailConfig(
      await env.SITE_CONFIG.get(CATCHALL_EMAIL_KEY),
    )
    const db = createDb()
    const mailboxPlans: CatchAllMailboxPlan[] = []
    normalizedCatchAllConfig = Object.create(null) as CatchAllEmailConfig

    for (const domain of domains) {
      const rawSettings = submittedDomainSettings.get(domain)
      if (!isRecord(rawSettings)) {
        return Response.json({ error: `无效的 Catch-all 域名配置: ${domain}` }, { status: 400 })
      }

      const { enabled, showAlways, mailboxName: rawMailboxName } = rawSettings
      if (typeof enabled !== "boolean" || typeof showAlways !== "boolean" || typeof rawMailboxName !== "string") {
        return Response.json({ error: `无效的 Catch-all 域名配置: ${domain}` }, { status: 400 })
      }

      const mailboxName = normalizeMailboxName(rawMailboxName)
      const currentDomainConfig = currentCatchAllConfig[domain]
      if (!mailboxName) {
        if (enabled || currentDomainConfig) {
          return Response.json({ error: `请为 ${domain} 配置 Catch-all 邮箱名`, code: "CATCH_ALL_MAILBOX_NAME_REQUIRED" }, { status: 400 })
        }
        continue
      }

      if (!isValidMailboxName(mailboxName)) {
        return Response.json({ error: `Catch-all 邮箱名格式无效: ${rawMailboxName}`, code: "INVALID_CATCH_ALL_MAILBOX_NAME" }, { status: 400 })
      }

      const address = `${mailboxName}@${domain}`
      const [registered] = await db.select({ email: emails }).from(catchAllMailboxes)
        .innerJoin(emails, eq(catchAllMailboxes.emailId, emails.id))
        .where(eq(catchAllMailboxes.domain, domain)).limit(1)
      const configuredEmail = registered?.email ?? (currentDomainConfig
        ? await findEmailByAddress(db, currentDomainConfig.address)
        : undefined)
      const ownedCurrentEmail = configuredEmail?.userId === userId ? configuredEmail : undefined
      const emailAtDesiredAddress = await findEmailByAddress(db, address)
      if (emailAtDesiredAddress && emailAtDesiredAddress.id !== ownedCurrentEmail?.id) {
        return Response.json({ error: `邮箱地址已被占用: ${address}`, code: "CATCH_ALL_ADDRESS_OCCUPIED" }, { status: 409 })
      }

      normalizedCatchAllConfig[domain] = { address, enabled, showAlways }
      mailboxPlans.push({ domain, emailId: ownedCurrentEmail?.id ?? crypto.randomUUID(), address, currentEmail: ownedCurrentEmail })
    }

    const noExpiry = new Date("9999-01-01T00:00:00.000Z")
    const mailboxWrites = mailboxPlans.flatMap(plan => {
      const registration = env.DB.prepare(
        "INSERT INTO catch_all_mailbox (domain, email_id) VALUES (?, ?) ON CONFLICT(domain) DO UPDATE SET email_id = excluded.email_id",
      ).bind(plan.domain, plan.emailId)
      if (!plan.currentEmail) {
        return [env.DB.prepare(
          "INSERT INTO email (id, address, userId, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
        ).bind(plan.emailId, plan.address, userId, Date.now(), noExpiry.getTime()), registration]
      }

      if (plan.currentEmail.address === plan.address && plan.currentEmail.expiresAt.getTime() === noExpiry.getTime()) {
        return [registration]
      }

      return [env.DB.prepare(
        "UPDATE email SET address = ?, expires_at = ? WHERE id = ? AND userId = ?",
      ).bind(plan.address, noExpiry.getTime(), plan.currentEmail.id, userId), registration]
    })

    if (mailboxWrites.length) {
      try {
        await env.DB.batch(mailboxWrites)
      } catch (error) {
        const message = error instanceof Error ? error.message : ""
        if (/unique constraint failed: email\.address|email_address_lower_idx/i.test(message)) {
          return Response.json({ error: "邮箱地址已被占用", code: "CATCH_ALL_ADDRESS_OCCUPIED" }, { status: 409 })
        }
        console.error("Failed to save Catch-all mailboxes", safeErrorMetadata(error))
        return Response.json({ error: "保存 Catch-all 邮箱失败" }, { status: 500 })
      }
    }
  }

  const writes: Promise<void>[] = [
    env.SITE_CONFIG.put("DEFAULT_ROLE", defaultRole),
    env.SITE_CONFIG.put("EMAIL_DOMAINS", domains.join(",")),
    env.SITE_CONFIG.put("ADMIN_CONTACT", adminContact),
    env.SITE_CONFIG.put("MAX_EMAILS", maxEmails),
    env.SITE_CONFIG.put("TURNSTILE_ENABLED", turnstileConfig.enabled.toString()),
    env.SITE_CONFIG.put("TURNSTILE_SITE_KEY", turnstileConfig.siteKey),
    env.SITE_CONFIG.put("TURNSTILE_SECRET_KEY", turnstileConfig.secretKey),
  ]

  if (normalizedCatchAllConfig) {
    writes.push(
      Object.keys(normalizedCatchAllConfig).length > 0
        ? env.SITE_CONFIG.put(CATCHALL_EMAIL_KEY, JSON.stringify(normalizedCatchAllConfig))
        : env.SITE_CONFIG.delete(CATCHALL_EMAIL_KEY),
    )
  }

  try {
    await Promise.all(writes)
  } catch (error) {
    console.error("Failed to save website configuration", safeErrorMetadata(error))
    return Response.json({ error: "保存配置失败" }, { status: 500 })
  }

  return Response.json({ success: true })
}
