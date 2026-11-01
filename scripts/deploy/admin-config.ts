import { z } from "zod"
import { normalizeEmailDomains } from "../../app/lib/email-domains"
import { isValidMailboxName } from "../../app/lib/mailbox-name"
import { parseCatchAllEmailConfig, type CatchAllEmailConfig } from "../../app/lib/catch-all"
import { parsePositiveSafeInteger } from "../../app/lib/max-emails"

const domainSettings = z.object({
  address: z.string(),
  enabled: z.boolean(),
  showAlways: z.boolean().default(true),
}).strict()
const resendSettings = z.object({ enabled: z.boolean(), apiKey: z.string() }).strict()
const roleLimits = z.object({
  duke: z.number().int().safe().min(-1).optional(),
  knight: z.number().int().safe().min(-1).optional(),
}).strict()

export const SITE_SETTING_NAMES = [
  "DEFAULT_ROLE", "EMAIL_DOMAINS", "ADMIN_CONTACT", "MAX_EMAILS",
  "TURNSTILE_ENABLED", "TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY",
  "RESEND_CONFIG", "EMAIL_ROLE_LIMITS", "CATCHALL_EMAIL",
] as const

export type AdminDeploymentConfig = {
  values: Record<string, string>
  initialEmailDomain: string
  catchAll?: CatchAllEmailConfig
  catchAllOwner?: string
}

export type AdminConfigStore = {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<unknown>
}

export type DeploymentQuery = (sql: string, params?: string[]) => Promise<Record<string, unknown>[]>

function invalid(name: string): never {
  // Never include a configuration value: JSON settings can contain credentials.
  throw new Error(`Invalid deployment setting: ${name}`)
}

function jsonSetting<T>(name: string, value: string, schema: z.ZodType<T>): T {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { return invalid(name) }
  const result = schema.safeParse(parsed)
  if (!result.success) return invalid(name)
  return result.data
}

export function readAdminDeploymentConfig(env: Record<string, string | undefined>): AdminDeploymentConfig {
  const values: Record<string, string> = {}
  for (const name of SITE_SETTING_NAMES) {
    if (env[name]?.trim()) values[name] = env[name]!.trim()
  }
  if (values.DEFAULT_ROLE && !["civilian", "knight", "duke"].includes(values.DEFAULT_ROLE)) invalid("DEFAULT_ROLE")
  if (values.MAX_EMAILS) {
    const maxEmails = parsePositiveSafeInteger(values.MAX_EMAILS)
    if (maxEmails === null) invalid("MAX_EMAILS")
    values.MAX_EMAILS = String(maxEmails)
  }
  if (values.EMAIL_DOMAINS) {
    values.EMAIL_DOMAINS = normalizeEmailDomains(values.EMAIL_DOMAINS).join(",")
    if (!values.EMAIL_DOMAINS) invalid("EMAIL_DOMAINS")
  }
  if (values.TURNSTILE_ENABLED && !["true", "false"].includes(values.TURNSTILE_ENABLED)) invalid("TURNSTILE_ENABLED")
  if (values.EMAIL_ROLE_LIMITS) {
    values.EMAIL_ROLE_LIMITS = JSON.stringify(jsonSetting("EMAIL_ROLE_LIMITS", values.EMAIL_ROLE_LIMITS, roleLimits))
  }
  if (values.RESEND_CONFIG) {
    const parsed = jsonSetting("RESEND_CONFIG", values.RESEND_CONFIG, z.record(z.string(), resendSettings))
    const normalized: Record<string, z.infer<typeof resendSettings>> = {}
    for (const [domain, config] of Object.entries(parsed)) {
      const key = domain.trim().toLowerCase()
      if (!key || normalized[key] || (config.enabled && !config.apiKey.trim())) invalid("RESEND_CONFIG")
      normalized[key] = { ...config, apiKey: config.apiKey.trim() }
    }
    values.RESEND_CONFIG = JSON.stringify(normalized)
  }
  let catchAll: CatchAllEmailConfig | undefined
  if (values.CATCHALL_EMAIL) {
    const parsed = jsonSetting("CATCHALL_EMAIL", values.CATCHALL_EMAIL, z.record(z.string(), domainSettings))
    catchAll = parseCatchAllEmailConfig(JSON.stringify(parsed))
    if (Object.keys(catchAll).length !== Object.keys(parsed).length) invalid("CATCHALL_EMAIL")
    for (const config of Object.values(catchAll)) {
      if (!isValidMailboxName(config.address.split("@")[0])) invalid("CATCHALL_EMAIL")
    }
    delete values.CATCHALL_EMAIL
  }
  return {
    values,
    initialEmailDomain: normalizeEmailDomains(env.EMAIL_DOMAIN || "").join(","),
    catchAll,
    catchAllOwner: env.CATCHALL_OWNER_USERNAME?.trim() || undefined,
  }
}

export async function applyAdminSiteSettings(config: AdminDeploymentConfig, store: AdminConfigStore) {
  const currentDomains = await store.get("EMAIL_DOMAINS")
  const domains = normalizeEmailDomains(config.values.EMAIL_DOMAINS || currentDomains || config.initialEmailDomain)
  if (!domains.length) invalid("EMAIL_DOMAINS")
  const values = { ...config.values }
  // An upgrade without an override keeps the browser's domain selection.
  if (!currentDomains && !values.EMAIL_DOMAINS) values.EMAIL_DOMAINS = domains.join(",")
  for (const name of ["RESEND_CONFIG", "CATCHALL_EMAIL"] as const) {
    const domainKeys = name === "CATCHALL_EMAIL"
      ? Object.keys(config.catchAll || {})
      : Object.keys(JSON.parse(values.RESEND_CONFIG || "{}"))
    if (domainKeys.some(domain => !domains.includes(domain))) invalid(name)
  }
  if (config.catchAll && Object.keys(config.catchAll).length && domains.some(domain => !(domain in config.catchAll!))) invalid("CATCHALL_EMAIL")
  const turnstileEnabled = values.TURNSTILE_ENABLED ?? await store.get("TURNSTILE_ENABLED")
  if (turnstileEnabled === "true") {
    const siteKey = values.TURNSTILE_SITE_KEY ?? await store.get("TURNSTILE_SITE_KEY")
    const secretKey = values.TURNSTILE_SECRET_KEY ?? await store.get("TURNSTILE_SECRET_KEY")
    if (!siteKey?.trim() || !secretKey?.trim()) invalid("TURNSTILE_ENABLED (keys required)")
  }
  for (const [name, value] of Object.entries(values)) await store.put(name, value)
  return domains
}

export async function applyAdminCatchAllSettings(
  config: AdminDeploymentConfig,
  store: AdminConfigStore,
  query: DeploymentQuery,
) {
  if (!config.catchAll) return
  // Empty configuration explicitly disables all custom Catch-all destinations.
  if (!Object.keys(config.catchAll).length) {
    await store.put("CATCHALL_EMAIL", "{}")
    return
  }
  const owners = await query(
    `SELECT u.id, u.username FROM user u JOIN user_role ur ON ur.user_id = u.id
     JOIN role r ON r.id = ur.role_id WHERE r.name = 'emperor'`,
  )
  const owner = owners.find(user => !config.catchAllOwner || user.username === config.catchAllOwner)
  if (!owner || owners.length !== 1) {
    throw new Error("CATCHALL_EMAIL requires an existing emperor account; configure ADMIN_USERS or CATCHALL_OWNER_USERNAME")
  }
  const userId = String(owner.id)
  const current = parseCatchAllEmailConfig(await store.get("CATCHALL_EMAIL"))
  const plans = []
  // Validate every address before any mailbox changes.
  for (const [domain, settings] of Object.entries(config.catchAll)) {
    const [registered] = await query(
      "SELECT e.id, e.userId FROM catch_all_mailbox c JOIN email e ON e.id = c.email_id WHERE c.domain = ?", [domain],
    )
    const [legacy] = !registered && current[domain]
      ? await query("SELECT id, userId FROM email WHERE LOWER(address) = ?", [current[domain].address])
      : []
    const existing = registered || legacy
    const [occupied] = await query("SELECT id FROM email WHERE LOWER(address) = ?", [settings.address])
    if ((existing && existing.userId !== userId) || (occupied && occupied.id !== existing?.id)) {
      throw new Error("CATCHALL_EMAIL address is already owned by another mailbox")
    }
    plans.push({ domain, address: settings.address, id: String(existing?.id || crypto.randomUUID()), exists: Boolean(existing) })
  }
  for (const plan of plans) {
    if (!plan.exists) {
      await query(
        `INSERT INTO email (id, address, userId, created_at, expires_at)
         SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM catch_all_mailbox WHERE domain = ?)`,
        [plan.id, plan.address, userId, String(Date.now()), String(new Date("9999-01-01T00:00:00Z").getTime()), plan.domain],
      )
    }
    await query("INSERT INTO catch_all_mailbox (domain, email_id) VALUES (?, ?) ON CONFLICT(domain) DO NOTHING", [plan.domain, plan.id])
    const renamed = await query(
      `UPDATE email SET address = ?, expires_at = ? WHERE id = (SELECT email_id FROM catch_all_mailbox WHERE domain = ?)
       AND userId = ? RETURNING id`,
      [plan.address, String(new Date("9999-01-01T00:00:00Z").getTime()), plan.domain, userId],
    )
    if (renamed.length !== 1) throw new Error("Catch-all owner changed during deployment; configuration was not published")
  }
  await store.put("CATCHALL_EMAIL", JSON.stringify(config.catchAll))
}
