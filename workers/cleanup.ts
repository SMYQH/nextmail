import { CLEANUP_EMAILS_SQL } from "../app/lib/database-statements"

interface Env { DB: D1Database }

const BATCH_SIZE = 100

export default {
  async scheduled(_: ScheduledEvent, env: Env) {
    const now = Date.now()
    let deleted = 0
    let count: number
    // Deletes emails and their messages (cascade via ON DELETE CASCADE on message.emailId)
    do {
      const result = await env.DB.prepare(CLEANUP_EMAILS_SQL).bind(now, BATCH_SIZE).all<{ id: string }>()
      if (!result.success) throw new Error("Expired email cleanup failed")
      // D1 meta.changes includes cascaded records, not just mailboxes.
      count = result.results.length
      deleted += count
    } while (count === BATCH_SIZE)
    console.info("Expired email cleanup completed", { deleted })
  },
}
