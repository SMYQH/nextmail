// Each statement is atomic on D1/SQLite; callers must not split the check and write.
export const RESERVE_SEND_SQL = `
  INSERT INTO send_usage (user_id, day, used) VALUES (?, ?, 1)
  ON CONFLICT(user_id, day) DO UPDATE SET used = send_usage.used + 1
  WHERE ? = 0 OR send_usage.used < ?
  RETURNING used
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

export const CLEANUP_EMAILS_SQL = `
  DELETE FROM email WHERE id IN (
    SELECT id FROM email WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
  )
  RETURNING id
`
