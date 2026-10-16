import { createDb } from "./db"
import { apiKeys, userRoles } from "./schema"
import { eq, and, gt } from "drizzle-orm"
import { auth, GET } from "./auth"
import { NextRequest } from "next/server"
import { headers } from "next/headers"
import { hasPermission, PERMISSIONS, type Permission, type Role } from "./permissions"
import { safeErrorMetadata } from "./safe-error"

type RequestIdentity = { userId: string; roles: Role[]; viaApiKey: boolean }

// Never trust a client-supplied identity header, even behind middleware.
export async function getRequestIdentity(requestHeaders?: Headers): Promise<RequestIdentity | undefined> {
  try {
    const headerList = requestHeaders ?? await headers()
    const key = headerList.get("X-API-Key")
    const db = createDb()
    let userId: string | undefined
    if (key !== null) {
      const apiKey = await db.query.apiKeys.findFirst({
        where: and(eq(apiKeys.key, key), eq(apiKeys.enabled, true), gt(apiKeys.expiresAt, new Date())),
      })
      userId = apiKey?.userId
    } else {
      if (requestHeaders) {
        // Middleware headers are explicit; auth() reads Next's ambient headers instead.
        const protocol = headerList.get("X-Forwarded-Proto") || "https"
        const host = headerList.get("X-Forwarded-Host") || headerList.get("Host") || "localhost"
        const response = await GET(new NextRequest(`${protocol}://${host}/api/auth/session`, { headers: headerList }))
        if (!response.ok) throw new Error("Auth session lookup failed")
        const session = await response.json() as { user?: { id?: string } } | null
        userId = session?.user?.id
      } else {
        userId = (await auth())?.user?.id
      }
    }
    if (!userId) return undefined
    const records = await db.query.userRoles.findMany({
      where: eq(userRoles.userId, userId),
      with: { role: true },
    })
    const roles = records.map(record => record.role.name as Role)
    if (key !== null && !hasPermission(roles, PERMISSIONS.MANAGE_API_KEY)) return undefined
    return { userId, roles, viaApiKey: key !== null }
  } catch (error) {
    console.error("Failed to resolve request identity:", safeErrorMetadata(error))
    throw new Error("Request identity lookup failed")
  }
}

export function identityHasPermission(identity: RequestIdentity, permission: Permission) {
  if (identity.viaApiKey && permission !== PERMISSIONS.MANAGE_EMAIL && permission !== PERMISSIONS.MANAGE_CONFIG) return false
  return hasPermission(identity.roles, permission)
}

export async function getUserId(permission?: Permission, requestHeaders?: Headers) {
  const identity = await getRequestIdentity(requestHeaders)
  if (!identity || (permission && !identityHasPermission(identity, permission))) return undefined
  return identity.userId
}
