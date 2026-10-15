import { safeErrorMetadata } from "@/lib/safe-error"
import { auth } from "@/lib/auth"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { CLAIM_EMPEROR_SQL } from "@/lib/database-statements"

async function initializeEmperor() {
  const session = await auth()
  if (!session?.user?.id) return Response.json({ error: "Unauthorized" }, { status: 401 })
  const db = getCloudflareContext().env.DB
  try {
    const results = await db.batch([
      db.prepare("INSERT INTO role (id, name, description) VALUES (?, 'emperor', 'Site owner') ON CONFLICT(name) DO NOTHING").bind(crypto.randomUUID()),
      db.prepare(CLAIM_EMPEROR_SQL).bind(session.user.id),
      db.prepare(`DELETE FROM user_role WHERE user_id = ? AND role_id != (SELECT id FROM role WHERE name = 'emperor')
        AND EXISTS (SELECT 1 FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE ur.user_id = ? AND r.name = 'emperor')`)
        .bind(session.user.id, session.user.id),
    ])
    if (!results[1].results.length) return Response.json({ error: "Emperor already exists" }, { status: 409 })
    return Response.json({ message: "Emperor initialized" })
  } catch (error) {
    console.error("Failed to initialize emperor:", safeErrorMetadata(error))
    return Response.json({ error: "Failed to initialize emperor" }, { status: 500 })
  }
}

export async function GET() {
  return initializeEmperor()
}

export async function POST() {
  return initializeEmperor()
}

// Next.js otherwise routes HEAD through GET, which would also initialize the role.
export async function HEAD() {
  return new Response(null, { status: 405, headers: { Allow: "GET, POST, OPTIONS" } })
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: { Allow: "GET, POST, OPTIONS" } })
}
