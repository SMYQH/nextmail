import {
  CLEANUP_EMAILS_SQL,
  CLEANUP_EMAIL_SHARES_SQL,
  CLEANUP_MESSAGE_SHARES_SQL,
  CLEANUP_API_KEYS_SQL,
} from "../app/lib/database-statements"

interface Env { DB: D1Database }

const CLEANUP_BATCH_SIZE = 100
const CLEANUP_MAX_BATCHES = 10

async function pruneExpired(db: D1Database, statement: string, cutoff: number, resource: string) {
  let deleted = 0
  let batches = 0
  let count: number
  do {
    const result = await db.prepare(statement).bind(cutoff, CLEANUP_BATCH_SIZE).all<{ id: string }>()
    if (!result.success) throw new Error(`Expired ${resource} cleanup failed`)
    batches++
    // D1 meta.changes includes cascaded rows, so count only returned records.
    count = result.results.length
    deleted += count
  } while (count === CLEANUP_BATCH_SIZE && batches < CLEANUP_MAX_BATCHES)
  const backlogMayRemain = count === CLEANUP_BATCH_SIZE && batches === CLEANUP_MAX_BATCHES
  if (backlogMayRemain) {
    console.warn("Expired resource cleanup reached the batch limit; more expired records may remain", { resource, deleted, batches })
  }
  return { deleted, batches, backlogMayRemain }
}

export default {
  async scheduled(_: ScheduledEvent, env: Env) {
    const now = Date.now()
    // Every resource gets a bounded budget, so a mailbox backlog cannot starve keys or shares.
    // At most four resources * ten batches are queried per invocation.
    const email = await pruneExpired(env.DB, CLEANUP_EMAILS_SQL, now, "email")
    console.info("Expired email cleanup invocation completed", email)
    const emailShares = await pruneExpired(env.DB, CLEANUP_EMAIL_SHARES_SQL, now, "email share")
    const messageShares = await pruneExpired(env.DB, CLEANUP_MESSAGE_SHARES_SQL, now, "message share")
    // API keys use timestamp seconds; shares and mailboxes use timestamp milliseconds.
    const apiKeys = await pruneExpired(env.DB, CLEANUP_API_KEYS_SQL, Math.floor(now / 1000), "API key")
    console.info("Expired share and API key cleanup invocation completed", { emailShares, messageShares, apiKeys })
  },
}
