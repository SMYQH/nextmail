import test, { after } from "node:test"
import assert from "node:assert/strict"
import { backfillDefaultRoles } from "../scripts/migrate"
import { createTestDatabase } from "./helpers/database"

const { sqlite } = createTestDatabase()
after(() => sqlite.close())

const config = {
  d1_databases: [{ binding: "DB", database_name: "nextmail-d1", database_id: "db-id" }],
  kv_namespaces: [{ binding: "SITE_CONFIG", id: "stale-duke-namespace" }],
}

async function withKVNamespaceId(value: string | undefined, callback: () => Promise<void>) {
  const previous = process.env.KV_NAMESPACE_ID
  if (value === undefined) delete process.env.KV_NAMESPACE_ID
  else process.env.KV_NAMESPACE_ID = value

  try {
    await callback()
  } finally {
    if (previous === undefined) delete process.env.KV_NAMESPACE_ID
    else process.env.KV_NAMESPACE_ID = previous
  }
}

test("remote backfill reads the selected project namespace instead of a stale SITE_CONFIG binding", async () => {
  await withKVNamespaceId("civilian-namespace", async () => {
    const commands: string[] = []
    const resolvedIds: string[] = []
    sqlite.exec("INSERT INTO user(id,username) VALUES('legacy-civilian','legacy-civilian')")

    await backfillDefaultRoles(config, "nextmail-d1", "remote", {
      expectedNamespaceTitle: "nextmail-kv",
      getKVNamespace: async id => {
        resolvedIds.push(id)
        return { id, title: "nextmail-kv" }
      },
      exec: async command => {
        commands.push(command)
        if (command.startsWith("wrangler kv key get")) {
          return { stdout: command.includes("--namespace-id civilian-namespace") ? "civilian" : "duke", stderr: "" }
        }
        return { stdout: "", stderr: "" }
      },
    })

    assert.deepEqual(resolvedIds, ["civilian-namespace"])
    assert.equal(commands[0], "wrangler kv key get DEFAULT_ROLE --namespace-id civilian-namespace --remote --text")
    const sqlMatch = commands[1].match(/--command "([\s\S]*)"$/)
    assert.ok(sqlMatch, "the selected role should be applied with D1 execute")
    sqlite.exec(sqlMatch[1].replace(/\\"/g, '"'))
    const grantedRole = sqlite.prepare("SELECT r.name FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE ur.user_id = 'legacy-civilian'").get() as { name: string } | undefined
    const completion = sqlite.prepare("SELECT role_name, completed FROM nextmail_migration_state WHERE id = 'default-role-backfill'").get() as { role_name: string; completed: number } | undefined
    assert.equal(grantedRole?.name, "civilian")
    assert.equal(completion?.role_name, "civilian")
    assert.equal(completion?.completed, 1)
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM role WHERE name = 'duke'").get()?.n, 0)
    assert.equal(commands.some(command => command.includes("stale-duke-namespace")), false)
    assert.equal(commands.some(command => command.includes("--binding SITE_CONFIG")), false)
  })
})

test("remote backfill rejects a missing override namespace before reading or granting a role", async () => {
  await withKVNamespaceId("missing-namespace", async () => {
    const commands: string[] = []
    await assert.rejects(backfillDefaultRoles(config, "nextmail-d1", "remote", {
      expectedNamespaceTitle: "nextmail-kv",
      getKVNamespace: async () => {
        throw new Error("404 Not Found")
      },
      exec: async command => {
        commands.push(command)
        return { stdout: "duke", stderr: "" }
      },
    }), /could not be resolved/)
    assert.deepEqual(commands, [])
  })
})

test("remote backfill rejects a foreign override namespace before reading or granting a role", async () => {
  await withKVNamespaceId("foreign-namespace", async () => {
    const commands: string[] = []
    await assert.rejects(backfillDefaultRoles(config, "nextmail-d1", "remote", {
      expectedNamespaceTitle: "nextmail-kv",
      getKVNamespace: async id => ({ id, title: "another-project-kv" }),
      exec: async command => {
        commands.push(command)
        return { stdout: "duke", stderr: "" }
      },
    }), /project namespace/)
    assert.deepEqual(commands, [])
  })
})

test("a missing DEFAULT_ROLE in the selected namespace does not fall back to the stale binding", async () => {
  await withKVNamespaceId("civilian-namespace", async () => {
    const commands: string[] = []
    await backfillDefaultRoles(config, "nextmail-d1", "remote", {
      expectedNamespaceTitle: "nextmail-kv",
      getKVNamespace: async id => ({ id, title: "nextmail-kv" }),
      exec: async command => {
        commands.push(command)
        if (command.startsWith("wrangler kv key get")) {
          throw new Error("selected namespace has no DEFAULT_ROLE")
        }
        return { stdout: "", stderr: "" }
      },
    })

    assert.deepEqual(commands, [
      "wrangler kv key get DEFAULT_ROLE --namespace-id civilian-namespace --remote --text",
    ])
    assert.equal(commands.some(command => command.includes("--binding SITE_CONFIG")), false)
    assert.equal(commands.some(command => command.startsWith("wrangler d1 execute")), false)
  })
})

test("local backfill stays offline and uses the local binding when KV_NAMESPACE_ID is set", async () => {
  await withKVNamespaceId("remote-namespace-override", async () => {
    const commands: string[] = []
    let namespaceLookups = 0

    await backfillDefaultRoles(config, "nextmail-d1", "local", {
      expectedNamespaceTitle: "nextmail-kv",
      getKVNamespace: async id => {
        namespaceLookups += 1
        return { id, title: "nextmail-kv" }
      },
      exec: async command => {
        commands.push(command)
        if (command.startsWith("wrangler kv key get")) return { stdout: "duke", stderr: "" }
        return { stdout: "", stderr: "" }
      },
    })

    assert.equal(namespaceLookups, 0)
    assert.equal(commands[0], "wrangler kv key get DEFAULT_ROLE --binding SITE_CONFIG --local --text")
    assert.ok(commands[1].includes("--local"))
    assert.ok(commands[1].includes("VALUES ('default-role-backfill', 'duke'"))
    assert.equal(commands.some(command => command.includes("remote-namespace-override")), false)
    assert.equal(commands.some(command => command.includes("--remote")), false)
  })
})

test("full deployment backfills its applied default without reading a stale KV value", async () => {
  const database = createTestDatabase()
  try {
    database.sqlite.exec("INSERT INTO user(id) VALUES('legacy')")
    await withKVNamespaceId("selected-project", async () => {
      const commands: string[] = []
      await backfillDefaultRoles(config, "nextmail-d1", "remote", {
        appliedDefaultRole: "civilian",
        expectedNamespaceTitle: "nextmail-kv",
        getKVNamespace: async id => ({ id, title: "nextmail-kv" }),
        exec: async command => {
          commands.push(command)
          if (command.startsWith("wrangler kv key get")) return { stdout: "duke", stderr: "" }
          const sql = command.match(/--command "([\s\S]*)"$/)?.[1]
          assert.ok(sql)
          database.sqlite.exec(sql.replace(/\\"/g, '"'))
          return { stdout: "", stderr: "" }
        },
      })
      assert.equal(commands.length, 1)
      assert.equal(database.sqlite.prepare("SELECT r.name FROM user_role ur JOIN role r ON r.id=ur.role_id WHERE ur.user_id='legacy'").get()?.name, "civilian")
    })
  } finally { database.sqlite.close() }
})
