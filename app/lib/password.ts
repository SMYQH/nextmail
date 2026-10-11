import { hash, compare } from "bcryptjs"

// Password authentication requires Workers Paid (Standard usage model).
// Async bcrypt still consumes CPU beyond the Free plan's 10 ms request budget.
// See docs/deploy.md; keep the work factor rather than weakening password storage.
const COST = 10

// Prehash avoids bcrypt's 72-byte truncation, including for Unicode passwords.
async function prehash(password: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password))
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
}

export async function hashPassword(password: string): Promise<string> {
  return `bcrypt-sha256:${await hash(await prehash(password), COST)}`
}

export function needsPasswordUpgrade(stored: string) {
  return !stored.startsWith("bcrypt-sha256:")
}

export async function comparePassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false
  if (!needsPasswordUpgrade(stored)) {
    return compare(await prehash(password), stored.slice("bcrypt-sha256:".length))
  }
  // Replace legacy hashes after a successful login, preserving existing accounts.
  const legacy = await prehash(password + (process.env.AUTH_SECRET || ""))
  if (legacy.length !== stored.length) return false
  let difference = 0
  for (let i = 0; i < legacy.length; i++) difference |= legacy.charCodeAt(i) ^ stored.charCodeAt(i)
  return difference === 0
}
