interface CursorData {
  timestamp: number
  id: string
}

export class InvalidCursorError extends Error {
  constructor() {
    super("Invalid cursor")
    this.name = "InvalidCursorError"
  }
}

function decodePayload(cursor: string): unknown {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64').toString())
  } catch {
    throw new InvalidCursorError()
  }
}

function isCursorData(data: unknown): data is CursorData {
  return Boolean(data && typeof data === 'object' && !Array.isArray(data) &&
    'timestamp' in data && typeof data.timestamp === 'number' &&
    Number.isSafeInteger(data.timestamp) && !Number.isNaN(new Date(data.timestamp).getTime()) &&
    'id' in data && typeof data.id === 'string')
}

export function encodeCursor(timestamp: number, id: string): string {
  const data: CursorData = { timestamp, id }
  return Buffer.from(JSON.stringify(data)).toString('base64')
}

export function decodeCursor(cursor: string): CursorData {
  const data = decodePayload(cursor)
  if (!isCursorData(data)) throw new InvalidCursorError()
  return data
}

export function encodeArrivalCursor(sequence: number): string {
  return Buffer.from(JSON.stringify({ version: 1, sequence })).toString('base64')
}

export function decodeArrivalCursor(cursor: string): number {
  const data = decodePayload(cursor)
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    if ('version' in data && data.version === 1 &&
      'sequence' in data && typeof data.sequence === 'number' &&
      Number.isSafeInteger(data.sequence) && data.sequence >= 0) return data.sequence
    // Timestamp cursors from an older client replay once; the client deduplicates IDs.
    if (!('version' in data) && isCursorData(data)) return 0
  }
  throw new InvalidCursorError()
}
