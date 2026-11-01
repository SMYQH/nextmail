/**
 * Derives the key that identifies a single delivery.
 *
 * The Message-ID header identifies the message across redeliveries, so it is
 * combined with the recipient. A message without that header falls back to a
 * hash of the raw bytes, which still recognises an identical redelivery.
 */
export interface DeliveryKeyInput {
  /** Parsed raw message headers with lowercase keys. */
  headers: Array<{ key: string; value: string }>
  /** The envelope recipient the message was delivered to. */
  recipient: string
  /** The raw message bytes, hashed only when the message carries no Message-ID. */
  raw: Uint8Array<ArrayBuffer>
}

export async function buildDeliveryKey({ headers, recipient, raw }: DeliveryKeyInput): Promise<string> {
  const messageId = headers.find(header => header.key === "message-id")?.value.trim()
  if (messageId) {
    // The same message delivered to two recipients is stored twice, so the
    // recipient is part of the key.
    return `message-id:${messageId}:${recipient.toLowerCase()}`
  }
  // Only a message without a Message-ID needs the digest, so the raw bytes are
  // hashed on this branch alone.
  return `raw-digest:${await digestRawMessage(raw)}:${recipient.toLowerCase()}`
}

/** Computes the SHA-256 digest of the raw message bytes as lowercase hex. */
export async function digestRawMessage(raw: Uint8Array<ArrayBuffer>): Promise<string> {
  // The bytes already in memory are hashed in place, so the digest needs no
  // second copy of the raw message.
  const digest = await crypto.subtle.digest("SHA-256", raw)
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("")
}
