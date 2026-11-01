import { z } from "zod"
import { comparePassword, hashPassword } from "../../app/lib/password"
import { normalizeEmailDomains } from "../../app/lib/email-domains"
import { validateWebhookUrl } from "../../app/lib/webhook-policy"
import type { DeploymentQuery } from "./admin-config"

const ROLE_NAMES = ["emperor", "duke", "knight", "civilian"] as const
type RoleName = typeof ROLE_NAMES[number]
const MAX_ADMIN_USERS = 100
const MAX_ADMIN_API_KEYS = 500
const expiresAtSchema = z.string().datetime({ offset: true })

const adminApiKeySchema = z.object({
  name: z.string().refine(value => value.trim().length > 0),
  key: z.string().optional(),
  enabled: z.boolean().optional(),
  expiresAt: z.string().optional(),
}).strict()

const adminWebhookSchema = z.object({
  url: z.string().optional(),
  secret: z.string().optional(),
  enabled: z.boolean().optional(),
}).strict()

const adminUserSchema = z.object({
  username: z.string().min(1).max(20).regex(/^[a-zA-Z0-9_-]+$/),
  password: z.string().optional(),
  name: z.string().optional(),
  role: z.string().nullable().optional(),
  allowedDomains: z.array(z.string()).nullable().optional(),
  apiKeys: z.array(adminApiKeySchema).optional(),
  webhook: adminWebhookSchema.nullable().optional(),
}).strict()

export type AdminApiKeyPlan = {
  name: string
  key?: string
  enabled?: boolean
  expiresAt?: string
}

export type AdminWebhookPlan = {
  url?: string
  secret?: string
  enabled?: boolean
}

export type AdminUserPlan = {
  username: string
  password?: string
  name?: string
  role?: RoleName
  allowedDomains?: string[] | null
  apiKeys?: AdminApiKeyPlan[]
  webhook?: AdminWebhookPlan
}

export type AdminUsersPlan = AdminUserPlan[]

type Row = Record<string, unknown>

function invalid(name = "ADMIN_USERS"): never {
  // Configuration can contain passwords, API keys, and webhook secrets.
  throw new Error(`Invalid deployment setting: ${name}`)
}

function conflict(reason: string): never {
  // Callers may log this error; keep all configured credentials out of it.
  throw new Error(`ADMIN_USERS ${reason}`)
}

function normalizePlan(value: unknown): AdminUsersPlan {
  const parsed = z.array(adminUserSchema).safeParse(value)
  if (!parsed.success || parsed.data.length > MAX_ADMIN_USERS) return invalid()
  if (parsed.data.reduce((count, user) => count + (user.apiKeys?.length ?? 0), 0) > MAX_ADMIN_API_KEYS) return invalid()

  const seenUsernames = new Set<string>()
  const plan = parsed.data.map((user): AdminUserPlan => {
    if (seenUsernames.has(user.username)) invalid()
    seenUsernames.add(user.username)

    let role: RoleName | undefined
    if (user.role !== null && user.role !== undefined && user.role.trim()) {
      const normalizedRole = user.role.trim()
      if (!ROLE_NAMES.includes(normalizedRole as RoleName)) invalid()
      role = normalizedRole as RoleName
    }

    const seenKeyNames = new Set<string>()
    for (const apiKey of user.apiKeys ?? []) {
      if (seenKeyNames.has(apiKey.name)) invalid()
      seenKeyNames.add(apiKey.name)
      if (apiKey.expiresAt?.trim() && !expiresAtSchema.safeParse(apiKey.expiresAt).success) {
        invalid("ADMIN_USERS API key expiry")
      }
    }

    return {
      username: user.username,
      ...(user.password === undefined ? {} : { password: user.password }),
      ...(user.name === undefined ? {} : { name: user.name }),
      ...(role === undefined ? {} : { role }),
      ...(user.allowedDomains === undefined ? {} : { allowedDomains: user.allowedDomains }),
      ...(user.apiKeys === undefined ? {} : {
        apiKeys: user.apiKeys.map(apiKey => ({
          name: apiKey.name,
          ...(apiKey.key === undefined ? {} : { key: apiKey.key }),
          ...(apiKey.enabled === undefined ? {} : { enabled: apiKey.enabled }),
          ...(apiKey.expiresAt === undefined ? {} : { expiresAt: apiKey.expiresAt }),
        })),
      }),
      ...(user.webhook == null ? {} : { webhook: user.webhook }),
    }
  })

  return plan
}

export function readAdminUsers(env: Record<string, string | undefined>): AdminUsersPlan | undefined {
  const value = env.ADMIN_USERS
  if (value === undefined || value.trim() === "") return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return invalid()
  }
  return normalizePlan(parsed)
}

function columnText(row: Row | undefined, column: string): string | undefined {
  const value = row?.[column]
  return typeof value === "string" ? value : undefined
}

function nullableInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const number = typeof value === "number" ? value : Number(value)
  return Number.isFinite(number) ? Math.floor(number) : null
}

function columnBoolean(row: Row | undefined, column: string): boolean | undefined {
  const value = row?.[column]
  if (value === true || value === 1 || value === "1") return true
  if (value === false || value === 0 || value === "0") return false
  return undefined
}

function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined
}

function expiresAtSeconds(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) return invalid("ADMIN_USERS API key expiry")
  return Math.floor(milliseconds / 1000)
}

function roleDescription(role: RoleName) {
  return {
    emperor: "皇帝（网站所有者）",
    duke: "公爵（超级用户）",
    knight: "骑士（高级用户）",
    civilian: "平民（普通用户）",
  }[role]
}

type ApiKeyUpdate = { column: "key" | "enabled" | "expires_at"; value: string }
type PreparedApiKey = {
  id: string
  userId: string
  name: string
  create?: { key: string; enabled: boolean; expiresAt: number }
  updates: ApiKeyUpdate[]
}

type WebhookUpdate = { column: "url" | "secret" | "enabled"; value: string }
type PreparedWebhook = {
  id: string
  userId: string
  create?: { url: string; secret: string; enabled: boolean }
  updates: WebhookUpdate[]
}

type PreparedUser = {
  id: string
  username: string
  isNew: boolean
  original?: Row
  passwordToSet?: string
  passwordHash?: string
  nameToSet?: string
  roleToApply?: RoleName
  currentRoles: Array<{ id: string; name: RoleName }>
  roleNeedsChange: boolean
  domainAction?: { type: "remove" } | { type: "set"; domains: string }
  apiKeys: PreparedApiKey[]
  webhook?: PreparedWebhook
}

function sameNullableInteger(left: unknown, right: number): boolean {
  return nullableInteger(left) === right
}

function normalizedDomains(requested: string[], configured: Set<string>): string[] {
  const result = new Set<string>()
  for (const rawDomain of requested) {
    const domain = rawDomain.trim().toLowerCase()
    if (!domain || domain.includes(",") || !configured.has(domain)) invalid("ADMIN_USERS allowedDomains")
    result.add(domain)
  }
  return [...result].sort()
}

function normalizeWebhookUrl(value: string, allowedWebhookHosts: string): string {
  try {
    return validateWebhookUrl(value, allowedWebhookHosts).toString()
  } catch {
    return invalid("ADMIN_USERS webhook")
  }
}

async function prepareApiKeys(
  userId: string,
  plans: AdminApiKeyPlan[] | undefined,
  query: DeploymentQuery,
  plannedKeyOwners: Map<string, string>,
): Promise<PreparedApiKey[]> {
  const prepared: PreparedApiKey[] = []
  for (const plan of plans ?? []) {
    const [existing] = await query(
      "SELECT id, user_id, name, key, enabled, expires_at FROM api_keys WHERE user_id = ? AND name = ? LIMIT 1",
      [userId, plan.name],
    )
    const key = nonBlank(plan.key)?.trim()
    const expiresAt = expiresAtSeconds(plan.expiresAt)
    const owner = `${userId}\n${plan.name}`
    if (key) {
      const plannedOwner = plannedKeyOwners.get(key)
      if (plannedOwner && plannedOwner !== owner) conflict("contains duplicate API key values")
      plannedKeyOwners.set(key, owner)

      const [collision] = await query(
        "SELECT id, user_id, name FROM api_keys WHERE key = ? LIMIT 1",
        [key],
      )
      if (collision && (columnText(collision, "user_id") !== userId || columnText(collision, "name") !== plan.name)) {
        conflict("API key ownership conflicts with an existing account")
      }
    }

    if (!existing) {
      if (!key) conflict("requires a key when creating an API key")
      prepared.push({
        id: crypto.randomUUID(),
        userId,
        name: plan.name,
        create: {
          key,
          enabled: plan.enabled ?? true,
          expiresAt: expiresAt ?? Math.floor((Date.now() + 365 * 24 * 60 * 60 * 1000) / 1000),
        },
        updates: [],
      })
      continue
    }

    const id = columnText(existing, "id")
    const currentKey = columnText(existing, "key")
    if (!id || !currentKey) conflict("contains an invalid existing API key record")
    const updates: ApiKeyUpdate[] = []
    if (key !== undefined && key !== currentKey) updates.push({ column: "key", value: key })
    if (plan.enabled !== undefined && plan.enabled !== columnBoolean(existing, "enabled")) {
      updates.push({ column: "enabled", value: plan.enabled ? "1" : "0" })
    }
    if (expiresAt !== undefined && !sameNullableInteger(existing.expires_at, expiresAt)) {
      updates.push({ column: "expires_at", value: String(expiresAt) })
    }
    prepared.push({ id, userId, name: plan.name, updates })
  }
  return prepared
}

async function prepareWebhook(
  userId: string,
  plan: AdminWebhookPlan | undefined,
  query: DeploymentQuery,
  allowedWebhookHosts: string,
): Promise<PreparedWebhook | undefined> {
  if (!plan) return undefined
  const [existing] = await query(
    "SELECT id, user_id, url, secret, enabled FROM webhook WHERE user_id = ? LIMIT 1",
    [userId],
  )
  const requestedUrl = nonBlank(plan.url)
  const secret = nonBlank(plan.secret)

  if (!existing) {
    if (!requestedUrl) {
      if (secret !== undefined || plan.enabled !== undefined) conflict("requires a URL when creating a webhook")
      return undefined
    }
    const enabled = plan.enabled ?? true
    const url = enabled ? normalizeWebhookUrl(requestedUrl, allowedWebhookHosts) : requestedUrl
    return {
      id: crypto.randomUUID(),
      userId,
      create: { url, secret: secret ?? crypto.randomUUID(), enabled },
      updates: [],
    }
  }

  const id = columnText(existing, "id")
  const currentUrl = columnText(existing, "url")
  if (!id || !currentUrl) conflict("contains an invalid existing webhook record")
  const enabled = plan.enabled ?? columnBoolean(existing, "enabled") ?? false
  const effectiveUrl = enabled
    ? normalizeWebhookUrl(requestedUrl ?? currentUrl, allowedWebhookHosts)
    : requestedUrl ?? currentUrl
  const updates: WebhookUpdate[] = []
  if (requestedUrl !== undefined && effectiveUrl !== currentUrl) updates.push({ column: "url", value: effectiveUrl })
  if (secret !== undefined && secret !== columnText(existing, "secret")) updates.push({ column: "secret", value: secret })
  if (plan.enabled !== undefined && plan.enabled !== columnBoolean(existing, "enabled")) {
    updates.push({ column: "enabled", value: plan.enabled ? "1" : "0" })
  }
  return updates.length ? { id, userId, updates } : undefined
}

export async function applyAdminUsers(
  input: AdminUsersPlan | undefined,
  query: DeploymentQuery,
  configuredDomains: readonly string[],
  allowedWebhookHosts: string,
): Promise<void> {
  if (input === undefined) return
  const plan = normalizePlan(input)
  if (plan.length === 0) return

  const domainSet = new Set(normalizeEmailDomains(configuredDomains.join(",")))
  const currentEmperors = await query(
    `SELECT ur.user_id AS user_id FROM user_role ur
     JOIN role r ON r.id = ur.role_id WHERE r.name = 'emperor'`,
  )
  const emperorIds = new Set(currentEmperors.map(row => columnText(row, "user_id")).filter((id): id is string => Boolean(id)))
  const plannedKeyOwners = new Map<string, string>()
  const prepared: PreparedUser[] = []

  for (const userPlan of plan) {
    const [existing] = await query(
      "SELECT id, username, name, password FROM user WHERE username = ? LIMIT 1",
      [userPlan.username],
    )
    const isNew = !existing
    const id = existing ? columnText(existing, "id") : crypto.randomUUID()
    if (!id) conflict("contains an invalid account record")

    const currentPassword = columnText(existing, "password")
    if (existing) {
      const linkedAccounts = await query("SELECT provider FROM account WHERE userId = ? LIMIT 1", [id])
      if (linkedAccounts.length > 0 || !currentPassword) {
        conflict("cannot claim an existing OAuth or unowned account")
      }
    }

    const passwordToSet = nonBlank(userPlan.password)
    if (passwordToSet && passwordToSet.length < 8) invalid("ADMIN_USERS password")
    if (isNew && !passwordToSet) conflict("requires a password for a new account")

    const currentRoleRows = existing
      ? await query(
          `SELECT ur.role_id AS id, r.name AS name FROM user_role ur
           JOIN role r ON r.id = ur.role_id WHERE ur.user_id = ?`,
          [id],
        )
      : []
    const currentRoles = currentRoleRows.flatMap(row => {
      const roleId = columnText(row, "id")
      const name = columnText(row, "name")
      return roleId && name && ROLE_NAMES.includes(name as RoleName)
        ? [{ id: roleId, name: name as RoleName }]
        : []
    })
    const roleToApply = userPlan.role ?? (isNew ? "civilian" : undefined)
    if (currentRoles.some(role => role.name === "emperor") && roleToApply && roleToApply !== "emperor") {
      conflict("cannot demote an emperor")
    }
    const effectiveRoles = roleToApply ? [roleToApply] : currentRoles.map(role => role.name)
    if ((userPlan.apiKeys?.length ?? 0) > 0 && !effectiveRoles.some(role => role === "emperor" || role === "duke")) {
      conflict("cannot assign API keys to a role without API key authority")
    }
    const webhookPlan = userPlan.webhook
    const hasWebhookChanges = webhookPlan && (
      nonBlank(webhookPlan.url) !== undefined ||
      nonBlank(webhookPlan.secret) !== undefined ||
      webhookPlan.enabled !== undefined
    )
    if (hasWebhookChanges && !effectiveRoles.some(role => role === "emperor" || role === "duke" || role === "knight")) {
      conflict("cannot configure a webhook for a role without webhook authority")
    }

    const hasEmperorRole = effectiveRoles.includes("emperor")
    let domainAction: PreparedUser["domainAction"]
    if (userPlan.allowedDomains !== undefined) {
      if (userPlan.allowedDomains === null) {
        domainAction = { type: "remove" }
      } else {
        const domains = normalizedDomains(userPlan.allowedDomains, domainSet)
        if (hasEmperorRole) conflict("cannot restrict an emperor's email domains")
        domainAction = { type: "set", domains: JSON.stringify(domains) }
      }
    } else if (roleToApply === "emperor") {
      // Becoming emperor clears any stale restriction so it cannot affect a later role change.
      domainAction = { type: "remove" }
    }

    let existingDomainAccess: Row | undefined
    if (domainAction) {
      ;[existingDomainAccess] = await query(
        "SELECT user_id, domains FROM user_email_domain_access WHERE user_id = ? LIMIT 1",
        [id],
      )
      if (domainAction.type === "set" && existingDomainAccess?.domains === domainAction.domains) domainAction = undefined
      if (domainAction?.type === "remove" && !existingDomainAccess) domainAction = undefined
    }

    const apiKeys = await prepareApiKeys(id, userPlan.apiKeys, query, plannedKeyOwners)
    const webhook = hasWebhookChanges
      ? await prepareWebhook(id, userPlan.webhook, query, allowedWebhookHosts)
      : undefined
    const roleNeedsChange = roleToApply !== undefined && (
      currentRoles.length !== 1 || currentRoles[0]?.name !== roleToApply
    )
    const nameToSet = nonBlank(userPlan.name)?.trim()

    prepared.push({
      id,
      username: userPlan.username,
      isNew,
      ...(existing ? { original: existing } : {}),
      ...(passwordToSet ? { passwordToSet } : {}),
      ...(nameToSet !== undefined && (isNew || nameToSet !== columnText(existing, "name")) ? { nameToSet } : {}),
      ...(roleToApply === undefined ? {} : { roleToApply }),
      currentRoles,
      roleNeedsChange,
      ...(domainAction ? { domainAction } : {}),
      apiKeys,
      ...(webhook ? { webhook } : {}),
    })
  }

  const emperorTargets = prepared.filter(user => user.roleToApply === "emperor")
  if (emperorTargets.length > 1) conflict("cannot assign emperor to multiple accounts")
  for (const target of emperorTargets) {
    if ([...emperorIds].some(id => id !== target.id)) conflict("cannot assign a second emperor")
  }

  // Hash only after every account, role, domain, API key, and webhook has passed preflight.
  for (const user of prepared) {
    if (!user.passwordToSet) continue
    const existingPassword = columnText(user.original, "password")
    if (existingPassword && await comparePassword(user.passwordToSet, existingPassword)) continue
    user.passwordHash = await hashPassword(user.passwordToSet)
  }

  const roleIds = new Map<RoleName, string>()
  const roleNames = [...new Set(prepared.flatMap(user => user.roleToApply ? [user.roleToApply] : []))]
  for (const roleName of roleNames) {
    const [existingRole] = await query("SELECT id FROM role WHERE name = ? LIMIT 1", [roleName])
    const existingRoleId = columnText(existingRole, "id")
    if (existingRoleId) roleIds.set(roleName, existingRoleId)
    else roleIds.set(roleName, crypto.randomUUID())
  }

  const nowMs = String(Date.now())
  const nowSeconds = String(Math.floor(Date.now() / 1000))

  // All user rows exist before role and owner-scoped resources are applied.
  for (const user of prepared) {
    if (user.isNew) {
      if (!user.passwordHash) conflict("new account password was not prepared")
      const nameSql = user.nameToSet === undefined ? "NULL" : "?"
      const params = [user.id, user.username, user.passwordHash]
      if (user.nameToSet !== undefined) params.push(user.nameToSet)
      const inserted = await query(
        `INSERT INTO user (id, username, password, name) VALUES (?, ?, ?, ${nameSql}) RETURNING id`,
        params,
      )
      if (!inserted.length) conflict("account changed during deployment")
    } else {
      const fields: Array<{ column: "password" | "name"; value: string }> = []
      if (user.passwordHash) fields.push({ column: "password", value: user.passwordHash })
      if (user.nameToSet !== undefined) fields.push({ column: "name", value: user.nameToSet })
      if (fields.length) {
        const params: string[] = []
        const assignments = fields.map(field => {
          params.push(field.value)
          return `${field.column} = ?`
        })
        params.push(user.id, user.username)
        const updated = await query(
          `UPDATE user SET ${assignments.join(", ")} WHERE id = ? AND username = ? RETURNING id`,
          params,
        )
        if (!updated.length) conflict("account changed during deployment")
      }
    }
  }

  for (const roleName of roleNames) {
    const roleId = roleIds.get(roleName)!
    const [existingRole] = await query("SELECT id FROM role WHERE name = ? LIMIT 1", [roleName])
    if (existingRole) continue
    await query(
      `INSERT INTO role (id, name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO NOTHING`,
      [roleId, roleName, roleDescription(roleName), nowSeconds, nowSeconds],
    )
    const [createdRole] = await query("SELECT id FROM role WHERE name = ? LIMIT 1", [roleName])
    const createdRoleId = columnText(createdRole, "id")
    if (!createdRoleId) conflict("role changed during deployment")
    roleIds.set(roleName, createdRoleId)
  }

  for (const user of prepared) {
    if (user.roleNeedsChange && user.roleToApply) {
      const roleId = roleIds.get(user.roleToApply)
      if (!roleId) conflict("role was not prepared")
      const roleAssignment = user.currentRoles.length
        ? await query(
            `UPDATE OR REPLACE user_role SET role_id = ? WHERE user_id = ?
             ${user.roleToApply === "emperor" ? "" : `AND NOT EXISTS (
               SELECT 1 FROM user_role current_role JOIN role current_role_name ON current_role_name.id = current_role.role_id
               WHERE current_role.user_id = user_role.user_id AND current_role_name.name = 'emperor'
             )`}
             RETURNING user_id`,
            [roleId, user.id],
          )
        : await query(
            `INSERT INTO user_role (user_id, role_id)
             SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM user_role WHERE user_id = ?)
             RETURNING user_id`,
            [user.id, roleId, user.id],
          )
      if (!roleAssignment.length) conflict("role changed during deployment")
    }

    if (user.domainAction?.type === "remove") {
      await query("DELETE FROM user_email_domain_access WHERE user_id = ?", [user.id])
    } else if (user.domainAction?.type === "set") {
      await query(
        `INSERT INTO user_email_domain_access (user_id, domains) VALUES (?, ?)
         ON CONFLICT(user_id) DO UPDATE SET domains = excluded.domains`,
        [user.id, user.domainAction.domains],
      )
    }

    for (const apiKey of user.apiKeys) {
      if (apiKey.create) {
        const params = [
          apiKey.id,
          apiKey.userId,
          apiKey.name,
          apiKey.create.key,
          nowSeconds,
          String(apiKey.create.expiresAt),
          apiKey.create.enabled ? "1" : "0",
        ]
        await query(
          `INSERT INTO api_keys (id, user_id, name, key, created_at, expires_at, enabled)
           VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
          params,
        )
      } else if (apiKey.updates.length) {
        const params: string[] = []
        const assignments = apiKey.updates.map(update => {
          params.push(update.value)
          return `${update.column} = ?`
        })
        params.push(apiKey.id, apiKey.userId)
        const updated = await query(
          `UPDATE api_keys SET ${assignments.join(", ")} WHERE id = ? AND user_id = ? RETURNING id`,
          params,
        )
        if (!updated.length) conflict("API key owner changed during deployment")
      }
    }

    if (user.webhook?.create) {
      const params = [
        user.webhook.id,
        user.webhook.userId,
        user.webhook.create.url,
        user.webhook.create.secret,
        user.webhook.create.enabled ? "1" : "0",
        nowMs,
        nowMs,
      ]
      await query(
        `INSERT INTO webhook (id, user_id, url, secret, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        params,
      )
    } else if (user.webhook?.updates.length) {
      const params: string[] = []
      const assignments = user.webhook.updates.map(update => {
        params.push(update.value)
        return `${update.column} = ?`
      })
      params.push(nowMs, user.webhook.id, user.webhook.userId)
      const updated = await query(
        `UPDATE webhook SET ${assignments.join(", ")}, updated_at = ? WHERE id = ? AND user_id = ? RETURNING id`,
        params,
      )
      if (!updated.length) conflict("webhook owner changed during deployment")
    }
  }
}
