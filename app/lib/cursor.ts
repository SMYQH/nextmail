interface CursorData {
  timestamp: number
  id: string
}

export function encodeCursor(timestamp: number, id: string): string {
  const data: CursorData = { timestamp, id }
  return Buffer.from(JSON.stringify(data)).toString('base64')
}

export function decodeCursor(cursor: string): CursorData {
  const data = JSON.parse(Buffer.from(cursor, 'base64').toString())
  return data as CursorData
}

export function encodeArrivalCursor(sequence: number): string {
  return Buffer.from(JSON.stringify({ version: 1, sequence })).toString('base64')
}

export function decodeArrivalCursor(cursor: string): number {
  const data = JSON.parse(Buffer.from(cursor, 'base64').toString())
  // Timestamp cursors from an older client replay once; the client deduplicates IDs.
  if (data.version !== 1 || !Number.isSafeInteger(data.sequence) || data.sequence < 0) return 0
  return data.sequence
}
