// null means permanent; undefined means the request must be rejected.
export function parseShareExpiry(body: unknown): Date | null | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined

  const { expiresIn = 0 } = body as { expiresIn?: unknown }
  if (typeof expiresIn !== "number" || !Number.isSafeInteger(expiresIn) || expiresIn < 0) {
    return undefined
  }
  if (expiresIn === 0) return null

  const expiresAt = new Date(Date.now() + expiresIn)
  return Number.isNaN(expiresAt.getTime()) ? undefined : expiresAt
}
