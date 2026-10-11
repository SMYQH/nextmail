import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import sodium from "libsodium-wrappers"
import { parseRepositoryUrl, readSecretsFromEnv, syncGitHubSecrets, syncLocalGitHubSecrets } from "../scripts/deploy/github-secrets"

test("repository URLs are limited to a GitHub owner and repository", () => {
  assert.equal(parseRepositoryUrl("https://github.com/example/nextmail.git"), "example/nextmail")
  assert.equal(parseRepositoryUrl("git@github.com:example/nextmail.git"), "example/nextmail")
  for (const url of [
    "https://github.com.evil.example/example/nextmail",
    "https://github.com/example/nextmail/other",
    "https://user:token@github.com/example/nextmail",
    "https://github.com/example/nextmail?redirect=1",
  ]) assert.throws(() => parseRepositoryUrl(url), /REPOSITORY_URL/)
})

test("local sync is disabled without both settings and in GitHub Actions", async () => {
  await assert.doesNotReject(syncLocalGitHubSecrets({ REPOSITORY_URL: "https://github.com/example/nextmail" }))
  await assert.doesNotReject(syncLocalGitHubSecrets({ GITHUB_TOKEN: "local-only" }))
  await assert.doesNotReject(syncLocalGitHubSecrets({ GITHUB_ACTIONS: "true", REPOSITORY_URL: "https://github.com/example/nextmail", GITHUB_TOKEN: "local-only" }))
})

test("sync encrypts .env settings and excludes the GitHub bootstrap credentials", async t => {
  await sodium.ready
  const directory = mkdtempSync(join(tmpdir(), "nextmail-github-secrets-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const envFilePath = join(directory, ".env")
  writeFileSync(envFilePath, 'AUTH_SECRET="synthetic-test-secret"\nEMAIL_DOMAIN="example.com"\nWEBHOOK_ALLOWED_HOSTS=""\nREPOSITORY_URL="https://github.com/example/nextmail"\nGITHUB_TOKEN="synthetic-bootstrap-token"\n')
  const keypair = sodium.crypto_box_keypair()
  const uploaded = new Map<string, string>()
  let publicKeyRequests = 0
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer synthetic-bootstrap-token")
    assert.equal(init?.redirect, "error")
    if (url.endsWith("/public-key")) {
      publicKeyRequests++
      return Response.json({ key: sodium.to_base64(keypair.publicKey, sodium.base64_variants.ORIGINAL), key_id: "test-key" })
    }
    assert.equal(init?.method, "PUT")
    const body = JSON.parse(String(init?.body)) as { encrypted_value: string; key_id: string }
    assert.equal(body.key_id, "test-key")
    assert.ok(!String(init?.body).includes("synthetic-test-secret"))
    const plaintext = sodium.crypto_box_seal_open(sodium.from_base64(body.encrypted_value, sodium.base64_variants.ORIGINAL), keypair.publicKey, keypair.privateKey)
    uploaded.set(url.split("/").at(-1)!, sodium.to_string(plaintext))
    return new Response(null, { status: 204 })
  }) as typeof fetch

  assert.equal(await syncGitHubSecrets({ repositoryUrl: "https://github.com/example/nextmail", token: "synthetic-bootstrap-token", envFilePath, fetchImpl }), 3)
  assert.equal(publicKeyRequests, 1)
  assert.deepEqual(Object.fromEntries(uploaded), {
    AUTH_SECRET: "synthetic-test-secret",
    EMAIL_DOMAIN: "example.com",
    WEBHOOK_ALLOWED_HOSTS: "",
  })
  assert.equal(uploaded.has("GITHUB_TOKEN"), false)
  assert.equal(uploaded.has("REPOSITORY_URL"), false)
})

test("invalid names and API failures stop sync without printing secret values", async t => {
  const directory = mkdtempSync(join(tmpdir(), "nextmail-github-secrets-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const envFilePath = join(directory, ".env")
  writeFileSync(envFilePath, 'GITHUB_UNEXPECTED="synthetic-secret"\n')
  assert.throws(() => readSecretsFromEnv(envFilePath), /Invalid GitHub Actions secret name/)
  writeFileSync(envFilePath, 'AUTH_SECRET="synthetic-secret"\n')
  const fetchImpl = (async () => new Response(null, { status: 403 })) as typeof fetch
  await assert.rejects(
    syncGitHubSecrets({ repositoryUrl: "https://github.com/example/nextmail", token: "synthetic-bootstrap-token", envFilePath, fetchImpl }),
    error => error instanceof Error && /HTTP 403/.test(error.message) && !error.message.includes("synthetic-secret"),
  )
})
