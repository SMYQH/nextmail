import { safeErrorMetadata } from "@/lib/safe-error"
import { createDb } from "@/lib/db"
import { users, userRoles, roles, userEmailDomainAccess } from "@/lib/schema"
import { eq, inArray, like, or, sql } from "drizzle-orm"
import { checkPermission } from "@/lib/auth"
import { PERMISSIONS, ROLES } from "@/lib/permissions"
import { parseUserAllowedEmailDomains } from "@/lib/user-email-domain-access"


export async function GET(request: Request) {
  const canPromote = await checkPermission(PERMISSIONS.PROMOTE_USER)
  if (!canPromote) {
    return Response.json({ error: "权限不足" }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const page = Number(searchParams.get("page") ?? "1")
  const pageSize = Number(searchParams.get("pageSize") ?? "20")
  if (!Number.isSafeInteger(page) || page < 1) {
    return Response.json({ error: "无效的页码" }, { status: 400 })
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    return Response.json({ error: "无效的分页大小" }, { status: 400 })
  }
  const search = searchParams.get("search")?.trim()

  const db = createDb()

  try {
    const searchCondition = search
      ? or(
          like(users.username, `%${search}%`),
          like(users.email, `%${search}%`),
          like(users.name, `%${search}%`)
        )
      : undefined

    const totalResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(users)
      .where(searchCondition)
    const total = Number(totalResult[0].count)

    const roleRank = sql`CASE COALESCE(${roles.name}, ${ROLES.CIVILIAN})
      WHEN ${ROLES.EMPEROR} THEN 0
      WHEN ${ROLES.DUKE} THEN 1
      WHEN ${ROLES.KNIGHT} THEN 2
      WHEN ${ROLES.CIVILIAN} THEN 3
      ELSE 4
    END`

    const userList = await db
      .select({
        id: users.id,
        name: users.name,
        username: users.username,
        email: users.email,
        image: users.image,
        role: roles.name,
      })
      .from(users)
      .leftJoin(userRoles, eq(userRoles.userId, users.id))
      .leftJoin(roles, eq(roles.id, userRoles.roleId))
      .where(searchCondition)
      .orderBy(roleRank, sql`LENGTH(COALESCE(${users.username}, ${users.name}))`, sql`LOWER(COALESCE(${users.username}, ${users.name}))`)
      .limit(pageSize)
      .offset((page - 1) * pageSize)

    const accessRows = userList.length
      ? await db
          .select({ userId: userEmailDomainAccess.userId, domains: userEmailDomainAccess.domains })
          .from(userEmailDomainAccess)
          .where(inArray(userEmailDomainAccess.userId, userList.map(user => user.id)))
      : []
    const domainAccessByUser = new Map(accessRows.map(access => [
      access.userId,
      parseUserAllowedEmailDomains(access.domains),
    ]))

    return Response.json({
      users: userList.map((u) => ({
        id: u.id,
        name: u.name,
        username: u.username,
        email: u.email,
        image: u.image,
        role: u.role || null,
        allowedDomains: u.role === ROLES.EMPEROR ? null : domainAccessByUser.get(u.id) ?? null,
      })),
      total,
      page,
      pageSize,
    })
  } catch (error) {
    console.error("Failed to list users:", safeErrorMetadata(error))
    return Response.json({ error: "获取用户列表失败" }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const canPromote = await checkPermission(PERMISSIONS.PROMOTE_USER)
  if (!canPromote) {
    return Response.json({ error: "权限不足" }, { status: 403 })
  }

  try {
    const json = await request.json().catch(() => null) as { searchText?: unknown } | null
    const searchText = typeof json?.searchText === "string" ? json.searchText : ""

    if (!searchText) {
      return Response.json({ error: "请提供用户名或邮箱地址" }, { status: 400 })
    }

    const db = createDb()

    const user = await db.query.users.findFirst({
      where: searchText.includes('@') ? eq(users.email, searchText) : eq(users.username, searchText),
      with: {
        userRoles: {
          with: {
            role: true
          }
        }
      }
    });

    if (!user) {
      return Response.json({ error: "未找到用户" }, { status: 404 })
    }

    return Response.json({
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        email: user.email,
        role: user.userRoles[0]?.role.name
      }
    })
  } catch (error) {
    console.error("Failed to find user:", safeErrorMetadata(error))
    return Response.json(
      { error: "查询用户失败" },
      { status: 500 }
    )
  }
}
