import { safeErrorMetadata } from "./safe-error"
import { RESERVE_SEND_SQL } from "./database-statements"
import { createDb } from "@/lib/db"
import { userRoles, roles, sendUsage } from "@/lib/schema"
import { eq, and } from "drizzle-orm"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { EMAIL_CONFIG } from "@/config"
import { getEnabledResendDomains, getResendConfigForAddress, loadResendConfig } from "@/lib/resend"

export interface SendPermissionResult {
  canSend: boolean
  error?: string
  remainingEmails?: number
  enabledDomains?: string[]
}

export async function checkSendPermission(
  userId: string,
  skipDailyLimitCheck = false,
  address?: string,
): Promise<SendPermissionResult> {
  try {
    const env = getCloudflareContext().env
    const { config } = await loadResendConfig(env.SITE_CONFIG)
    const enabledDomains = getEnabledResendDomains(config)

    const addressConfig = address ? getResendConfigForAddress(config, address) : undefined
    const domainCanSend = address
      ? Boolean(addressConfig?.enabled && addressConfig.apiKey.trim())
      : enabledDomains.length > 0

    if (!domainCanSend) {
      return {
        canSend: false,
        error: address ? "该邮箱域名未启用 Resend 发件服务" : "邮件发送服务未启用",
        enabledDomains,
      }
    }

    const userDailyLimit = await getUserDailyLimit(userId)

    if (userDailyLimit === -1) {
      return {
        canSend: false,
        error: "您的角色没有发件权限",
        enabledDomains,
      }
    }

    if (skipDailyLimitCheck || userDailyLimit === 0) {
      return {
        canSend: true,
        enabledDomains,
      }
    }

    const db = createDb()
    const today = new Date().toISOString().slice(0, 10)
    const usage = await db.query.sendUsage.findFirst({
      where: and(eq(sendUsage.userId, userId), eq(sendUsage.day, today)),
    })
    const sentToday = usage?.used ?? 0

    const remainingEmails = Math.max(0, userDailyLimit - sentToday)

    if (sentToday >= userDailyLimit) {
      return {
        canSend: false,
        error: `您今天已达到发件限制 (${userDailyLimit} 封)，请明天再试`,
        remainingEmails: 0,
        enabledDomains,
      }
    }

    return {
      canSend: true,
      remainingEmails,
      enabledDomains,
    }
  } catch (error) {
    console.error('Failed to check send permission:', safeErrorMetadata(error))
    return {
      canSend: false,
      error: "权限检查失败"
    }
  }
}

async function getUserDailyLimit(userId: string): Promise<number> {
  try {
    const db = createDb()

    const userRoleData = await db
      .select({ roleName: roles.name })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .where(eq(userRoles.userId, userId))

    const userRoleNames = userRoleData.map(r => r.roleName)

    const env = getCloudflareContext().env
    const roleLimitsStr = await env.SITE_CONFIG.get("EMAIL_ROLE_LIMITS")

    const customLimits = roleLimitsStr ? JSON.parse(roleLimitsStr) : {}

    const finalLimits = {
      emperor: EMAIL_CONFIG.DEFAULT_DAILY_SEND_LIMITS.emperor,
      duke: customLimits.duke !== undefined ? customLimits.duke : EMAIL_CONFIG.DEFAULT_DAILY_SEND_LIMITS.duke,
      knight: customLimits.knight !== undefined ? customLimits.knight : EMAIL_CONFIG.DEFAULT_DAILY_SEND_LIMITS.knight,
      civilian: EMAIL_CONFIG.DEFAULT_DAILY_SEND_LIMITS.civilian,
    }

    if (userRoleNames.includes("emperor")) {
      return finalLimits.emperor
    } else if (userRoleNames.includes("duke")) {
      return finalLimits.duke
    } else if (userRoleNames.includes("knight")) {
      return finalLimits.knight
    } else if (userRoleNames.includes("civilian")) {
      return finalLimits.civilian
    }

    return -1
  } catch (error) {
    console.error('Failed to get user daily limit:', safeErrorMetadata(error))
    return -1
  }
}

export async function checkBasicSendPermission(userId: string): Promise<SendPermissionResult> {
  return checkSendPermission(userId, true)
}
export async function reserveSend(userId: string, address?: string): Promise<SendPermissionResult & { day?: string }> {
  const permission = await checkSendPermission(userId, true, address)
  if (!permission.canSend) return permission
  const limit = await getUserDailyLimit(userId)
  if (limit < 0) return { canSend: false, error: "Your role cannot send email" }
  const day = new Date().toISOString().slice(0, 10)
  const row = await getCloudflareContext().env.DB.prepare(RESERVE_SEND_SQL)
    .bind(userId, day, limit, limit).first<{ used: number }>()
  if (!row) return { canSend: false, error: "Daily send limit reached", remainingEmails: 0 }
  return { canSend: true, day, remainingEmails: limit === 0 ? undefined : Math.max(0, limit - row.used) }
}

export async function releaseSend(userId: string, day: string) {
  await getCloudflareContext().env.DB.prepare("UPDATE send_usage SET used = MAX(0, used - 1) WHERE user_id = ? AND day = ?")
    .bind(userId, day).run()
}
