import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  DATABASE_ID_PLACEHOLDER,
  KV_NAMESPACE_ID_PLACEHOLDER,
  generateWranglerConfigs,
  resolveZoneName,
} from "../scripts/deploy/generate-wrangler-config"

const ROOT = resolve(".")
const TEMPLATES = ["wrangler.example.json", "wrangler.email.example.json", "wrangler.cleanup.example.json"]
const GENERATED = ["wrangler.json", "wrangler.email.json", "wrangler.cleanup.json"]
const DATABASE_ID = "11111111-2222-3333-4444-555555555555"
const NAMESPACE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

function createFixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "nextmail-wrangler-config-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  for (const template of TEMPLATES) {
    writeFileSync(join(directory, template), readFileSync(join(ROOT, template), "utf8"))
  }
  return directory
}

test("the tracked Wrangler templates carry no deployment resource IDs", () => {
  for (const template of TEMPLATES) {
    const content = readFileSync(join(ROOT, template), "utf8")
    assert.doesNotMatch(content, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, `${template} must not carry a database id`)
    assert.doesNotMatch(content, /"[0-9a-f]{32}"/i, `${template} must not carry a namespace id`)
    const config = JSON.parse(content)
    const ids = [
      ...(config.d1_databases ?? []).map((database: { database_id?: string }) => database.database_id),
      ...(config.kv_namespaces ?? []).map((namespace: { id?: string }) => namespace.id),
    ]
    for (const id of ids) {
      assert.ok(id === DATABASE_ID_PLACEHOLDER || id === KV_NAMESPACE_ID_PLACEHOLDER, `${template} must keep placeholders only`)
    }
  }
})

test("the generated Wrangler configs are ignored while the templates stay tracked", () => {
  const entries = readFileSync(join(ROOT, ".gitignore"), "utf8").split(/\r?\n/).map(line => line.trim())
  for (const name of GENERATED) {
    assert.ok(entries.includes(name), `${name} must stay ignored`)
  }
  for (const name of TEMPLATES) {
    assert.ok(!entries.includes(name), `${name} must stay tracked`)
  }
})

test("generated Wrangler configs take the configured resource IDs and keep credentials out", t => {
  const directory = createFixture(t)
  const { written } = generateWranglerConfigs(directory, {
    DATABASE_ID,
    KV_NAMESPACE_ID: NAMESPACE_ID,
    CLOUDFLARE_API_TOKEN: "synthetic-private-token",
  })
  assert.deepEqual(written, GENERATED)

  const main = JSON.parse(readFileSync(join(directory, "wrangler.json"), "utf8"))
  assert.equal(main.d1_databases[0].database_id, DATABASE_ID)
  assert.equal(main.kv_namespaces[0].id, NAMESPACE_ID)
  assert.equal(main.main, ".open-next/worker.js")

  const email = JSON.parse(readFileSync(join(directory, "wrangler.email.json"), "utf8"))
  assert.equal(email.d1_databases[0].database_id, DATABASE_ID)
  assert.equal(email.kv_namespaces[0].id, NAMESPACE_ID)

  const cleanup = JSON.parse(readFileSync(join(directory, "wrangler.cleanup.json"), "utf8"))
  assert.equal(cleanup.d1_databases[0].database_id, DATABASE_ID)

  for (const name of GENERATED) {
    assert.doesNotMatch(readFileSync(join(directory, name), "utf8"), /synthetic-private-token/)
  }
})

test("generated Wrangler configs keep the placeholders until the resources are resolved", t => {
  const directory = createFixture(t)
  generateWranglerConfigs(directory, {})
  const main = JSON.parse(readFileSync(join(directory, "wrangler.json"), "utf8"))
  assert.equal(main.d1_databases[0].database_id, DATABASE_ID_PLACEHOLDER)
  assert.equal(main.kv_namespaces[0].id, KV_NAMESPACE_ID_PLACEHOLDER)
})

test("regeneration keeps the resolved IDs and the deployed custom domain", t => {
  const directory = createFixture(t)
  const template = JSON.parse(readFileSync(join(directory, "wrangler.example.json"), "utf8"))
  writeFileSync(join(directory, "wrangler.json"), JSON.stringify({
    ...template,
    workers_dev: false,
    routes: [{ pattern: "mail.example.com", zone_name: "example.com", custom_domain: true }],
    d1_databases: [{ binding: "DB", database_name: "nextmail-d1", database_id: "resolved-database-id", migrations_dir: "drizzle" }],
    kv_namespaces: [{ binding: "SITE_CONFIG", id: "resolved-namespace-id" }],
  }, null, 2))

  const { bindings } = generateWranglerConfigs(directory, {})
  assert.equal(bindings.databaseId, "resolved-database-id")
  assert.equal(bindings.kvNamespaceId, "resolved-namespace-id")

  const main = JSON.parse(readFileSync(join(directory, "wrangler.json"), "utf8"))
  assert.equal(main.d1_databases[0].database_id, "resolved-database-id")
  assert.equal(main.kv_namespaces[0].id, "resolved-namespace-id")
  assert.equal(main.workers_dev, false)
  assert.deepEqual(main.routes, [{ pattern: "mail.example.com", zone_name: "example.com", custom_domain: true }])
})

test("a fresh config uses the configured custom domain and its Zone", t => {
  const directory = createFixture(t)
  const { bindings } = generateWranglerConfigs(directory, { CUSTOM_DOMAIN: "mail.example.com", EMAIL_DOMAIN: "example.com" })
  assert.deepEqual(bindings.route, { pattern: "mail.example.com", zone_name: "example.com", custom_domain: true })

  const main = JSON.parse(readFileSync(join(directory, "wrangler.json"), "utf8"))
  assert.equal(main.workers_dev, false)
  assert.deepEqual(main.routes, [{ pattern: "mail.example.com", zone_name: "example.com", custom_domain: true }])
})

test("custom domain Zones follow the mail Zone and otherwise drop the host label", () => {
  assert.equal(resolveZoneName("mail.example.com", "example.com"), "example.com")
  assert.equal(resolveZoneName("app.example.co.uk"), "example.co.uk")
  assert.equal(resolveZoneName("example.com"), "example.com")
})
