import test, { type TestContext } from "node:test"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { readdirSync, readFileSync } from "node:fs"
import { createTestDatabase } from "./helpers/database"
import { ASSIGN_DEFAULT_ROLE_SQL, CLAIM_EMPEROR_SQL, RESERVE_SEND_SQL } from "../app/lib/database-statements"

function migratedDatabase(t: TestContext) {
  const { sqlite } = createTestDatabase()
  t.after(() => sqlite.close())
  return sqlite
}

test("migration 0007 preserves existing credential usernames and password hashes", t => {
  const db = new DatabaseSync(":memory:", { enableDoubleQuotedStringLiterals: true })
  t.after(() => db.close())
  db.exec("PRAGMA foreign_keys = ON")

  for (const file of readdirSync("drizzle").filter(file => file.endsWith(".sql") && file < "0007_careless_sentinel.sql").sort()) {
    const migration = readFileSync(`drizzle/${file}`, "utf8")
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) db.exec(statement)
    }
  }

  db.exec("INSERT INTO user(id) VALUES ('legacy-user')")
  db.exec("INSERT INTO credential(id,userId,username,password,created_at) VALUES ('legacy-credential','legacy-user','legacy-name','synthetic-password-hash',0)")
  const migration = readFileSync("drizzle/0007_careless_sentinel.sql", "utf8")
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement)
  }

  const migratedCredential = db.prepare("SELECT username, password FROM user WHERE id = 'legacy-user'").get()
  assert.equal(migratedCredential?.username, "legacy-name")
  assert.equal(migratedCredential?.password, "synthetic-password-hash")
  assert.throws(() => db.prepare("SELECT * FROM credential").all(), /no such table: credential/)
})

test("migrations enforce case-insensitive email ownership", t => {
  const db = migratedDatabase(t)
  db.exec("INSERT INTO user(id) VALUES ('a'), ('b')")
  db.exec("INSERT INTO email(id,address,userId,created_at,expires_at) VALUES('a','Alice@example.com','a',0,999)")
  assert.throws(() => db.exec("INSERT INTO email(id,address,userId,created_at,expires_at) VALUES('b','alice@example.com','b',0,999)"), /UNIQUE/)
})

test("only one contender can claim Emperor, including direct assignments", t => {
  const db = migratedDatabase(t)
  db.exec("INSERT INTO user(id) VALUES ('a'), ('b'); INSERT INTO role(id,name) VALUES ('r','emperor')")
  assert.equal(db.prepare(CLAIM_EMPEROR_SQL).all("a").length, 1)
  assert.equal(db.prepare(CLAIM_EMPEROR_SQL).all("b").length, 0)
  assert.throws(() => db.exec("INSERT INTO user_role(user_id,role_id) VALUES ('b','r')"), /Only one emperor/)
  assert.throws(() => db.exec("INSERT INTO role(id,name) VALUES ('other','emperor')"), /UNIQUE/)
})

test("default-role assignment inserts only when the user still has no role", t => {
  const db = migratedDatabase(t)
  db.exec("INSERT INTO user(id) VALUES ('a'); INSERT INTO role(id,name) VALUES ('duke','duke'),('knight','knight')")

  const assign = db.prepare(ASSIGN_DEFAULT_ROLE_SQL)
  const firstAssignment = assign.get("a", "duke", "a")
  assert.equal(firstAssignment?.user_id, "a")
  assert.equal(firstAssignment?.role_id, "duke")
  assert.equal(assign.get("a", "knight", "a"), undefined)
  assert.deepEqual(
    db.prepare("SELECT role_id FROM user_role WHERE user_id = 'a'").all().map(row => row.role_id),
    ["duke"],
  )
})

test("send quota is isolated by user and day and survives mailbox deletion", t => {
  const db = migratedDatabase(t)
  db.exec("INSERT INTO user(id) VALUES ('a'); INSERT INTO email(id,address,userId,created_at,expires_at) VALUES('e','a@example.com','a',0,999)")
  // This verifies sequential SQL semantics; overlapping route requests are tested in routes.test.ts.
  const attempts = Array.from({ length: 30 }, () => db.prepare(RESERVE_SEND_SQL).get("a", "2026-09-05", 5, 5))
  assert.equal(attempts.filter(Boolean).length, 5)
  db.exec("DELETE FROM email WHERE id = 'e'")
  assert.equal(db.prepare(RESERVE_SEND_SQL).get("a", "2026-09-05", 5, 5), undefined)
  assert.ok(db.prepare(RESERVE_SEND_SQL).get("a", "2026-09-06", 5, 5))
  db.exec("INSERT INTO user(id) VALUES ('b')")
  assert.equal(db.prepare(RESERVE_SEND_SQL).get("b", "2026-09-05", 5, 5)?.used, 1)
  assert.equal(db.prepare("SELECT used FROM send_usage WHERE user_id = 'a' AND day = '2026-09-05'").get()?.used, 5)
})

test("unlimited send quota continues recording usage beyond ordinary role limits", t => {
  const db = migratedDatabase(t)
  db.exec("INSERT INTO user(id) VALUES ('a')")
  for (let used = 1; used <= 12; used++) {
    assert.equal(db.prepare(RESERVE_SEND_SQL).get("a", "2026-09-05", 0, 0)?.used, used)
  }
})
