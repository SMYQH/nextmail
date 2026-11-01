import { assertSafeBuildEnv } from "./validate-build-env"

/**
 * Settings every deployment must provide before a build or any remote change.
 */
export const REQUIRED_DEPLOY_ENV_NAMES = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "AUTH_SECRET",
  "EMAIL_DOMAIN",
  "NEXT_PUBLIC_BASE_URL",
] as const

/**
 * Rejects an incomplete deployment environment.
 *
 * NEXT_PUBLIC_BASE_URL is required because it is baked into the build; a
 * missing value would publish host-dependent canonical links.
 */
export function assertRequiredDeployEnv(
  environment: Record<string, string | undefined> = process.env,
  root?: string,
) {
  assertSafeBuildEnv(root)
  const missing = REQUIRED_DEPLOY_ENV_NAMES.filter((name) => !environment[name]?.trim())
  if (missing.length === 0) return

  const hint = missing.includes("NEXT_PUBLIC_BASE_URL")
    ? " (NEXT_PUBLIC_BASE_URL must be the public site URL, for example https://example.com)"
    : ""
  throw new Error(`Missing required environment variables: ${missing.join(", ")}${hint}`)
}