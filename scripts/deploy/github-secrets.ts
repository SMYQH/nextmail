import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { parse } from "dotenv"
import sodium from "libsodium-wrappers"

const GITHUB_API = "https://api.github.com"
const BOOTSTRAP_KEYS = new Set(["GITHUB_TOKEN", "REPOSITORY_URL"])

export function parseRepositoryUrl(repositoryUrl: string): string {
  let path: string
  if (repositoryUrl.startsWith("git@github.com:")) {
    path = repositoryUrl.slice("git@github.com:".length)
  } else {
    let url: URL
    try {
      url = new URL(repositoryUrl)
    } catch {
      throw new Error("REPOSITORY_URL must be a GitHub HTTPS or SSH repository URL")
    }
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash) {
      throw new Error("REPOSITORY_URL must be a GitHub HTTPS or SSH repository URL")
    }
    path = url.pathname.replace(/^\//, "")
  }

  const parts = path.replace(/\/$/, "").split("/")
  const owner = parts[0]
  const repo = parts[1]?.replace(/\.git$/, "")
  if (parts.length !== 2 || !owner || !repo || !/^[A-Za-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo) || repo === "." || repo === "..") {
    throw new Error("REPOSITORY_URL must identify one GitHub owner and repository")
  }
  return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
}

export function readSecretsFromEnv(envFilePath: string): Record<string, string> {
  const configuration = parse(readFileSync(envFilePath))
  const secrets: Record<string, string> = {}
  for (const [name, value] of Object.entries(configuration)) {
    const upperName = name.toUpperCase()
    if (BOOTSTRAP_KEYS.has(upperName)) continue
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || upperName.startsWith("GITHUB_")) {
      throw new Error(`Invalid GitHub Actions secret name in environment file: ${name}`)
    }
    if (Object.hasOwn(secrets, upperName)) {
      throw new Error(`Duplicate GitHub Actions secret name in environment file: ${upperName}`)
    }
    secrets[upperName] = value
  }
  if (Object.keys(secrets).length === 0) throw new Error("No deployment settings found in environment file")
  return secrets
}

export async function syncGitHubSecrets(options: {
  repositoryUrl: string
  token: string
  envFilePath: string
  fetchImpl?: typeof fetch
}): Promise<number> {
  const repository = parseRepositoryUrl(options.repositoryUrl)
  const secrets = readSecretsFromEnv(options.envFilePath)
  const fetchImpl = options.fetchImpl || fetch
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${options.token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  }
  const endpoint = `${GITHUB_API}/repos/${repository}/actions/secrets`
  const keyResponse = await fetchImpl(`${endpoint}/public-key`, { headers, redirect: "error" })
  if (!keyResponse.ok) throw new Error(`GitHub secret public key request failed (HTTP ${keyResponse.status})`)
  const publicKey = await keyResponse.json() as { key?: string; key_id?: string }
  if (!publicKey.key || !publicKey.key_id || Buffer.from(publicKey.key, "base64").length !== 32) {
    throw new Error("GitHub returned an invalid repository secret public key")
  }

  await sodium.ready
  const key = sodium.from_base64(publicKey.key, sodium.base64_variants.ORIGINAL)
  for (const [name, value] of Object.entries(secrets)) {
    const encryptedValue = sodium.to_base64(
      sodium.crypto_box_seal(sodium.from_string(value), key),
      sodium.base64_variants.ORIGINAL,
    )
    const response = await fetchImpl(`${endpoint}/${name}`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ encrypted_value: encryptedValue, key_id: publicKey.key_id }),
      redirect: "error",
    })
    if (response.status !== 201 && response.status !== 204) {
      throw new Error(`GitHub secret ${name} update failed (HTTP ${response.status})`)
    }
  }
  return Object.keys(secrets).length
}

export async function syncLocalGitHubSecrets(env: Record<string, string | undefined> = process.env): Promise<void> {
  if (env.GITHUB_ACTIONS === "true" || !env.REPOSITORY_URL?.trim() || !env.GITHUB_TOKEN?.trim()) return
  const count = await syncGitHubSecrets({
    repositoryUrl: env.REPOSITORY_URL,
    token: env.GITHUB_TOKEN,
    envFilePath: resolve(".env.deploy"),
  })
  console.log(`✅ Synced ${count} .env.deploy settings to GitHub Actions repository secrets`)
}
