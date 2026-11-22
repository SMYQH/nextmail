export const MAX_BULK_DELETE_IDS = 40
const MAX_BULK_DELETE_BODY_BYTES = 8 * 1024

function parseIds(body: unknown): string[] | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null
  const record = body as Record<string, unknown>
  if (Object.keys(record).length !== 1 || !Object.hasOwn(record, "ids")) return null
  const ids = record.ids
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BULK_DELETE_IDS) return null
  if (ids.some(id => typeof id !== "string" || id.length === 0 || id.length > 128)) return null
  if (new Set(ids).size !== ids.length) return null
  return ids as string[]
}

export async function readBulkDeleteIds(request: Request): Promise<string[] | null> {
  const rawContentLength = request.headers.get("content-length")
  if (rawContentLength && /^\d+$/.test(rawContentLength) && Number(rawContentLength) > MAX_BULK_DELETE_BODY_BYTES) {
    return null
  }

  if (!request.body) return null
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > MAX_BULK_DELETE_BODY_BYTES) {
        await reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(value)
    }
  } catch {
    return null
  }

  const bodyBytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  try {
    return parseIds(JSON.parse(new TextDecoder().decode(bodyBytes)))
  } catch {
    return null
  }
}
