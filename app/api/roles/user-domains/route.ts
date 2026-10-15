import { safeErrorMetadata } from "@/lib/safe-error"
import { createDb } from "@/lib/db"
import { userEmailDomainAccess, users } from "@/lib/schema"
import { checkPermission } from "@/lib/auth"
import { PERMISSIONS, ROLES } from "@/lib/permissions"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { eq } from "drizzle-orm"
import { normalizeEmailDomains } from "@/lib/email-domains"

export async function PATCH(request: Request) {
  if (!await checkPermission(PERMISSIONS.PROMOTE_USER)) {
    return Response.json({ error: "权限不足" }, { status: 403 })
  }

  try {
    let parsedBody: unknown
    try {
      parsedBody = await request.json()
    } catch {
      return Response.json({ error: "无效的请求数据" }, { status: 400 })
    }
    if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
      return Response.json({ error: "无效的请求数据" }, { status: 400 })
    }
    const body = parsedBody as { userId?: unknown; allowedDomains?: unknown }
    if (typeof body.userId !== "string" || !body.userId.trim()) {
      return Response.json({ error: "缺少必要参数" }, { status: 400 })
    }
    const userId = body.userId.trim()
    if (body.allowedDomains !== null && (!Array.isArray(body.allowedDomains) || body.allowedDomains.some(domain => typeof domain !== "string"))) {
      return Response.json({ error: "域名不合法" }, { status: 400 })
    }

    const db = createDb()
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      with: { userRoles: { with: { role: true } } },
    })
    if (!user) return Response.json({ error: "未找到用户" }, { status: 404 })
    if (user.userRoles.some(userRole => userRole.role.name === ROLES.EMPEROR)) {
      return Response.json({ error: "不能限制皇帝的邮箱域名" }, { status: 400 })
    }

    if (body.allowedDomains === null) {
      await db.delete(userEmailDomainAccess).where(eq(userEmailDomainAccess.userId, userId))
      return Response.json({ success: true, allowedDomains: null })
    }

    const rawDomains = body.allowedDomains as string[]
    const configuredDomains = normalizeEmailDomains(
      await getCloudflareContext().env.SITE_CONFIG.get("EMAIL_DOMAINS") || ""
    )
    const requestedDomains = rawDomains.map(domain => domain.trim().toLowerCase())
    if (requestedDomains.some(domain => !domain || domain.includes(",") || !configuredDomains.includes(domain))) {
      return Response.json({ error: "域名不合法" }, { status: 400 })
    }

    const allowedDomains = [...new Set(requestedDomains)]
    await db.insert(userEmailDomainAccess)
      .values({ userId, domains: JSON.stringify(allowedDomains) })
      .onConflictDoUpdate({
        target: userEmailDomainAccess.userId,
        set: { domains: JSON.stringify(allowedDomains) },
      })

    return Response.json({ success: true, allowedDomains })
  } catch (error) {
    console.error("Failed to update user email domains:", safeErrorMetadata(error))
    return Response.json({ error: "更新用户邮箱域名失败" }, { status: 500 })
  }
}
