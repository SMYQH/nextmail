import { sql, type SQL, type SQLWrapper } from "drizzle-orm"
import { decodeCursor, encodeCursor } from "./cursor"

export const OWNER_LIST_PAGE_SIZE = 100

interface OwnerListCursor {
  timestamp: number
  id: string
}

// null means the first page; undefined means malformed input.
export function readOwnerListCursor(request?: Request): OwnerListCursor | null | undefined {
  const value = request ? new URL(request.url).searchParams.get("cursor") : null
  if (value === null) return null
  if (!value || value.length > 2048) return undefined
  try {
    const cursor = decodeCursor(value)
    if (!cursor || typeof cursor !== "object" ||
      !Number.isSafeInteger(cursor.timestamp) || !Number.isFinite(new Date(cursor.timestamp).getTime()) ||
      typeof cursor.id !== "string" || !cursor.id || cursor.id.length > 256) return undefined
    return cursor
  } catch {
    return undefined
  }
}

export function ownerListBefore(timestamp: SQL<number>, id: SQLWrapper, cursor: OwnerListCursor | null) {
  if (!cursor) return undefined
  return sql`(${timestamp} < ${cursor.timestamp} OR (${timestamp} = ${cursor.timestamp} AND ${id} < ${cursor.id}))`
}

export function ownerListPage<T extends { id: string; createdAt: Date | null }>(rows: T[]) {
  const items = rows.slice(0, OWNER_LIST_PAGE_SIZE)
  const last = items.at(-1)
  return {
    items,
    nextCursor: rows.length > OWNER_LIST_PAGE_SIZE && last
      ? encodeCursor(last.createdAt?.getTime() ?? 0, last.id)
      : null,
  }
}
