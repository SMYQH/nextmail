import { config } from "dotenv"
import { resolve } from "node:path"
import { assertSafeBuildEnv } from "./validate-build-env"

const APP_RUNTIME_COMMANDS = new Set(["dev", "build", "start", "preview"])
const DEPLOY_ONLY_ENV_NAMES = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CF_API_TOKEN",
  "CF_API_KEY",
  "DATABASE_ID",
  "KV_NAMESPACE_ID",
  "CUSTOM_DOMAIN",
  "OPENAPI_WAF_VERIFY_SECRET",
  "EMAIL_DOMAIN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "REPOSITORY_URL",
  "DEFAULT_ROLE",
  "EMAIL_DOMAINS",
  "ADMIN_CONTACT",
  "MAX_EMAILS",
  "TURNSTILE_ENABLED",
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET_KEY",
  "CATCHALL_EMAIL",
  "RESEND_CONFIG",
  "EMAIL_ROLE_LIMITS",
  "ADMIN_USERS",
  "CATCHALL_OWNER_USERNAME",
  "NEXTMAIL_DEPLOY_DEFAULT_ROLE",
]

export function stripDeployEnvironment(environment: Record<string, string | undefined> = process.env) {
  for (const name of DEPLOY_ONLY_ENV_NAMES) delete environment[name]
}

export function preloadAppEnv(
  command = process.argv[2] ?? "",
  root = process.cwd(),
  environment: Record<string, string | undefined> = process.env,
) {
  // GitHub Actions receives settings only from explicit workflow environment
  // mappings. An ignored local file must never act as a CI fallback.
  if (environment.GITHUB_ACTIONS !== "true") {
    config({ path: resolve(root, ".env.deploy") })
  }
  assertSafeBuildEnv(root)

  // App and local Worker commands only need application runtime settings. Keep
  // deployment credentials and site seed values in the deployment process.
  if (APP_RUNTIME_COMMANDS.has(command)) stripDeployEnvironment(environment)
}
