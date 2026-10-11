import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { readdirSync, readFileSync } from "node:fs"

export function createTestDatabase() {
  // Historical migrations use double-quoted string literals.
  const sqlite = new DatabaseSync(":memory:", { enableDoubleQuotedStringLiterals: true })
  sqlite.exec("PRAGMA foreign_keys = ON")
  const migrations = readdirSync("drizzle").filter(file => file.endsWith(".sql")).sort()
  for (const file of migrations) {
    const content = readFileSync(`drizzle/${file}`, "utf8")
    for (const statement of content.split("--> statement-breakpoint")) {
      const trimmed = statement.trim()
      if (trimmed) sqlite.exec(trimmed)
    }
  }
  class Statement {
    constructor(private sql: string, private values: SQLInputValue[] = []) {}
    bind(...values: SQLInputValue[]) { return new Statement(this.sql, values) }
    async all() {
      const before = Number(sqlite.prepare("SELECT total_changes() AS n").get()?.n)
      const statement = sqlite.prepare(this.sql)
      const results = statement.all(...this.values)
      return { success: true, results, meta: { changes: Number(sqlite.prepare("SELECT total_changes() AS n").get()?.n) - before } }
    }
    async raw() {
      const statement = sqlite.prepare(this.sql)
      statement.setReturnArrays(true)
      return statement.all(...this.values)
    }
    async first(column?: string) {
      const row = sqlite.prepare(this.sql).get(...this.values)
      return column ? row?.[column] ?? null : row ?? null
    }
    async run() {
      const before = Number(sqlite.prepare("SELECT total_changes() AS n").get()?.n)
      sqlite.prepare(this.sql).run(...this.values)
      return { success: true, results: [], meta: { changes: Number(sqlite.prepare("SELECT total_changes() AS n").get()?.n) - before } }
    }
  }
  const d1 = {
    prepare: (sql: string) => new Statement(sql),
    async batch(statements: Statement[]) {
      sqlite.exec("BEGIN")
      try {
        const results = []
        for (const statement of statements) results.push(await statement.all())
        sqlite.exec("COMMIT")
        return results
      } catch (error) {
        sqlite.exec("ROLLBACK")
        throw error
      }
    },
  } as unknown as D1Database
  return { sqlite, d1 }
}
