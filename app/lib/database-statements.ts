// Each statement is atomic on D1/SQLite; callers must not split the check and write.
export const RESERVE_SEND_SQL = `
  INSERT INTO send_usage (user_id, day, used) VALUES (?, ?, 1)
  ON CONFLICT(user_id, day) DO UPDATE SET used = send_usage.used + 1
  WHERE ? = 0 OR send_usage.used < ?
  RETURNING used
`

export const INSERT_MAILBOX_WITH_LIMIT_SQL = `
  INSERT INTO email (id, address, userId, created_at, expires_at)
  SELECT ?, ?, ?, ?, ?
  WHERE ? = 0 OR (
    SELECT COUNT(*)
    FROM email
    WHERE userId = ?
      AND expires_at > ?
  ) < ?
  ON CONFLICT DO NOTHING
  RETURNING id, address
`

export const CLAIM_EMPEROR_SQL = `
  INSERT INTO user_role (user_id, role_id, created_at)
  SELECT ?, id, unixepoch() FROM role
  WHERE name = 'emperor'
    AND NOT EXISTS (SELECT 1 FROM user_role WHERE role_id = role.id)
  RETURNING user_id
`

export const ASSIGN_DEFAULT_ROLE_SQL = `
  INSERT INTO user_role (user_id, role_id, created_at)
  SELECT ?, ?, unixepoch()
  WHERE NOT EXISTS (SELECT 1 FROM user_role WHERE user_id = ?)
  RETURNING user_id, role_id
`

// The roles a site may hand to a new account, matching app/lib/auth.ts.
export const BACKFILLABLE_ROLES = ["duke", "knight", "civilian"] as const
export type BackfillableRole = typeof BACKFILLABLE_ROLES[number]

const BACKFILL_ROLE_DESCRIPTIONS: Record<BackfillableRole, string> = {
  duke: "公爵（超级用户）",
  knight: "骑士（高级用户）",
  civilian: "平民（无任何权限）",
}

/**
 * Builds the one-time data migration that grants the site's default role to
 * accounts that never received one. Its marker persists across migration
 * invocations so later role revocations are not undone.
 *
 * The role name comes from the site configuration, so it is validated against
 * the allowed set instead of being interpolated blindly.
 */
export function buildDefaultRoleBackfillSql(roleName: string) {
  if (!BACKFILLABLE_ROLES.includes(roleName as BackfillableRole)) {
    throw new Error(`Unsupported default role: ${roleName}`)
  }
  const role = roleName as BackfillableRole
  const description = BACKFILL_ROLE_DESCRIPTIONS[role]
  return `
CREATE TABLE IF NOT EXISTS nextmail_migration_state (
  id TEXT PRIMARY KEY,
  role_name TEXT NOT NULL,
  role_description TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0
);
CREATE TRIGGER IF NOT EXISTS nextmail_default_role_backfill
AFTER INSERT ON nextmail_migration_state
WHEN NEW.id = 'default-role-backfill' AND NEW.completed = 0
BEGIN
  INSERT OR IGNORE INTO role (id, name, description, created_at, updated_at)
  VALUES ('backfill-default-role', NEW.role_name, NEW.role_description, unixepoch(), unixepoch());
  INSERT OR IGNORE INTO user_role (user_id, role_id, created_at)
  SELECT u.id, r.id, unixepoch()
  FROM user u
  JOIN role r ON r.name = NEW.role_name
  WHERE NOT EXISTS (SELECT 1 FROM user_role ur WHERE ur.user_id = u.id);
  UPDATE nextmail_migration_state
  SET completed = 1
  WHERE id = NEW.id;
END;
INSERT OR IGNORE INTO nextmail_migration_state (id, role_name, role_description, completed)
VALUES ('default-role-backfill', '${role}', '${description}', 0);
`
}

export const CLEANUP_EMAILS_SQL = `
  DELETE FROM email WHERE id IN (
    SELECT id FROM email WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
  )
  RETURNING id
`

export const CLEANUP_EMAIL_SHARES_SQL = `
  DELETE FROM email_share WHERE id IN (
    SELECT id FROM email_share WHERE expires_at <= ? ORDER BY expires_at, id LIMIT ?
  )
  RETURNING id
`

export const CLEANUP_MESSAGE_SHARES_SQL = `
  DELETE FROM message_share WHERE id IN (
    SELECT id FROM message_share WHERE expires_at <= ? ORDER BY expires_at, id LIMIT ?
  )
  RETURNING id
`

export const CLEANUP_API_KEYS_SQL = `
  DELETE FROM api_keys WHERE id IN (
    SELECT id FROM api_keys WHERE expires_at <= ? ORDER BY expires_at, id LIMIT ?
  )
  RETURNING id
`
