import { safeErrorMetadata } from "@/lib/safe-error"
import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { checkPermission } from "@/lib/auth"
import { PERMISSIONS } from "@/lib/permissions"
import { EMAIL_CONFIG } from "@/config"
import {
  loadResendConfig,
  parseEmailRoleLimits,
  RESEND_CONFIG_KEY,
  type EmailRoleLimits,
  type ResendConfig,
} from "@/lib/resend"

interface EmailServiceConfigInput {
  domains: Record<string, {
    enabled: boolean
    apiKey?: string
  }>
  roleLimits: EmailRoleLimits
}

function isEmailServiceConfig(value: unknown): value is EmailServiceConfigInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false

  const config = value as Record<string, unknown>
  if (!config.domains || typeof config.domains !== "object" || Array.isArray(config.domains)) return false
  if (!config.roleLimits || typeof config.roleLimits !== "object" || Array.isArray(config.roleLimits)) return false

  const roleLimits = config.roleLimits as Record<string, unknown>
  if (!["duke", "knight"].every((role) => {
    const limit = roleLimits[role]
    return limit === undefined || (typeof limit === "number" && Number.isInteger(limit) && limit >= -1)
  })) {
    return false
  }

  return Object.values(config.domains).every((domainConfig) => {
    if (!domainConfig || typeof domainConfig !== "object" || Array.isArray(domainConfig)) return false
    const entry = domainConfig as Record<string, unknown>
    return typeof entry.enabled === "boolean"
      && (entry.apiKey === undefined || typeof entry.apiKey === "string")
  })
}

export async function GET() {
  const canAccess = await checkPermission(PERMISSIONS.MANAGE_CONFIG)

  if (!canAccess) {
    return NextResponse.json({ error: "权限不足" }, { status: 403 })
  }

  try {
    const env = getCloudflareContext().env
    const [{ configuredDomains, config: resendConfig }, roleLimitsValue] = await Promise.all([
      loadResendConfig(env.SITE_CONFIG),
      env.SITE_CONFIG.get("EMAIL_ROLE_LIMITS"),
    ])
    const customLimits = parseEmailRoleLimits(roleLimitsValue)
    const configuredDomainSet = new Set(configuredDomains)
    const visibleDomains = [
      ...configuredDomains,
      ...Object.keys(resendConfig).filter((domain) => domain !== "*" && !configuredDomainSet.has(domain)),
    ]

    const domains = visibleDomains.reduce<Record<string, {
      enabled: boolean
      apiKey: string
      hasApiKey: boolean
      configured: boolean
    }>>((result, domain) => {
      result[domain] = {
        enabled: resendConfig[domain]?.enabled === true,
        apiKey: "",
        hasApiKey: Boolean(resendConfig[domain]?.apiKey),
        configured: configuredDomainSet.has(domain),
      }
      return result
    }, {})

    return NextResponse.json({
      domains,
      roleLimits: {
        duke: customLimits.duke ?? EMAIL_CONFIG.DEFAULT_DAILY_SEND_LIMITS.duke,
        knight: customLimits.knight ?? EMAIL_CONFIG.DEFAULT_DAILY_SEND_LIMITS.knight,
      },
    }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    console.error("Failed to get email service config:", safeErrorMetadata(error))
    return NextResponse.json(
      { error: "获取 Resend 发件服务配置失败" },
      { status: 500 },
    )
  }
}

export async function POST(request: Request) {
  const canAccess = await checkPermission(PERMISSIONS.MANAGE_CONFIG)

  if (!canAccess) {
    return NextResponse.json({ error: "权限不足" }, { status: 403 })
  }

  try {
    const body = await request.json().catch(() => null)
    if (!isEmailServiceConfig(body)) {
      return NextResponse.json({ error: "无效的 Resend 发件服务配置" }, { status: 400 })
    }

    const env = getCloudflareContext().env
    const [{ configuredDomains, config: currentConfig }, roleLimitsValue] = await Promise.all([
      loadResendConfig(env.SITE_CONFIG),
      env.SITE_CONFIG.get("EMAIL_ROLE_LIMITS"),
    ])
    const nextConfig: ResendConfig = {}

    for (const domain of configuredDomains) {
      const submittedConfig = body.domains[domain]
      const enabled = submittedConfig?.enabled === true
      const submittedApiKey = submittedConfig?.apiKey?.trim() ?? ""
      const apiKey = submittedApiKey
        || currentConfig[domain]?.apiKey
        || currentConfig["*"]?.apiKey
        || ""

      if (enabled && !apiKey) {
        return NextResponse.json(
          { error: `启用 ${domain} 的 Resend 时，API Key 为必填项` },
          { status: 400 },
        )
      }

      nextConfig[domain] = { enabled, apiKey }
    }

    const customLimits: EmailRoleLimits = {}
    const existingLimits = parseEmailRoleLimits(roleLimitsValue)
    for (const role of ["duke", "knight"] as const) {
      const submittedLimit = body.roleLimits[role]
      if (submittedLimit !== undefined) customLimits[role] = submittedLimit
      else if (existingLimits[role] !== undefined) customLimits[role] = existingLimits[role]
    }

    await Promise.all([
      env.SITE_CONFIG.put(RESEND_CONFIG_KEY, JSON.stringify(nextConfig)),
      env.SITE_CONFIG.put("EMAIL_ROLE_LIMITS", JSON.stringify(customLimits)),
    ])

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("Failed to save email service config:", safeErrorMetadata(error))
    return NextResponse.json(
      { error: "保存 Resend 发件服务配置失败" },
      { status: 500 },
    )
  }
}
