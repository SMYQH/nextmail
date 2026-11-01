import { safeErrorMetadata } from "@/lib/safe-error"
import { auth } from "@/lib/auth"
import { createDb } from "@/lib/db"
import { apiKeys } from "@/lib/schema"
import { nanoid } from "nanoid"
import { NextResponse } from "next/server"
import { checkPermission } from "@/lib/auth"
import { PERMISSIONS } from "@/lib/permissions"
import { and, desc, eq, sql } from "drizzle-orm"
import { OWNER_LIST_PAGE_SIZE, ownerListBefore, ownerListPage, readOwnerListCursor } from "@/lib/owner-list-pagination"

function jsonNoStore(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers)
  headers.set("Cache-Control", "no-store")
  return NextResponse.json(body, { ...init, headers })
}

// Preserve direct no-argument callers while exposing the required route request type.
export function GET(): Promise<Response>
export function GET(request: Request): Promise<Response>
export async function GET(request?: Request) {
  const hasPermission = await checkPermission(PERMISSIONS.MANAGE_API_KEY)
  if (!hasPermission) {
    return jsonNoStore({ error: "权限不足" }, { status: 403 })
  }

  const session = await auth()
  const cursor = readOwnerListCursor(request)
  if (cursor === undefined) return jsonNoStore({ error: "Invalid cursor" }, { status: 400 })
  try {
    const db = createDb()
    // Normalize timestamp seconds (including legacy NULL dates) to cursor milliseconds.
    const createdAt = sql<number>`coalesce(${apiKeys.createdAt}, 0) * 1000`
    const rows = await db.query.apiKeys.findMany({
      where: and(eq(apiKeys.userId, session!.user.id!), ownerListBefore(createdAt, apiKeys.id, cursor)),
      orderBy: [desc(createdAt), desc(apiKeys.id)],
      limit: OWNER_LIST_PAGE_SIZE + 1,
    })
    const { items, nextCursor } = ownerListPage(rows)

    return jsonNoStore({
      apiKeys: items.map(({ id, name, key, createdAt, expiresAt, enabled }) => ({
        id,
        name,
        key,
        createdAt,
        expiresAt,
        enabled,
      })),
      nextCursor,
    })
  } catch (error) {
    console.error("Failed to fetch API keys:", safeErrorMetadata(error))
    return jsonNoStore(
      { error: "获取 API Keys 失败" },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  const hasPermission = await checkPermission(PERMISSIONS.MANAGE_API_KEY)
  if (!hasPermission) {
    return jsonNoStore({ error: "权限不足" }, { status: 403 })
  }

  const session = await auth()
  try {
    const body: unknown = await request.json().catch(() => null)
    if (!body || typeof body !== "object" || Array.isArray(body) ||
      !("name" in body) || typeof body.name !== "string" || !body.name.trim()) {
      return jsonNoStore(
        { error: "名称不能为空" },
        { status: 400 }
      )
    }

    const { name } = body
    const key = `mk_${nanoid(32)}`
    const db = createDb()
    
    const [created] = await db.insert(apiKeys).values({
      name,
      key,
      userId: session!.user.id!,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
    }).onConflictDoNothing({ target: [apiKeys.name, apiKeys.userId] }).returning({ id: apiKeys.id })

    if (!created) {
      return jsonNoStore(
        { error: "An API key with this name already exists", code: "API_KEY_NAME_EXISTS" },
        { status: 409 },
      )
    }

    return jsonNoStore({ key })
  } catch (error) {
    console.error("Failed to create API key:", safeErrorMetadata(error))
    return jsonNoStore(
      { error: "创建 API Key 失败" },
      { status: 500 }
    )
  }
}
