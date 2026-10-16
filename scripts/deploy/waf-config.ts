import type { PhaseGetResponse, PhaseUpdateParams } from "cloudflare/resources/rulesets/phases"

export const OPENAPI_WAF_PHASE = "http_request_firewall_custom" as const
export const OPENAPI_WAF_RULE_REF = "nextmail_openapi_waf_skip"
export const OPENAPI_WAF_VERIFY_RULE_REF = "nextmail_openapi_waf_verify_skip"
export const OPENAPI_WAF_VERIFY_HEADER = "x-nextmail-waf-verify"

const SKIP_PHASES = ["http_request_firewall_managed", "http_request_sbfm"] as const
const SKIP_PRODUCTS = ["bic", "hot", "securityLevel", "uaBlock", "waf", "zoneLockdown"] as const

export type WafRule = NonNullable<PhaseGetResponse["rules"]>[number]
type WafRuleUpdate = NonNullable<PhaseUpdateParams["rules"]>[number]
type WafSkipActionParameters = NonNullable<Extract<WafRuleUpdate, { action?: "skip" }>["action_parameters"]>

export type WafEntryPoint = {
  name?: string
  description?: string
  rules?: WafRule[]
}

export type WafEntryPointApi = {
  getEntryPoint: (zoneId: string) => Promise<WafEntryPoint | null>
  updateEntryPoint: (zoneId: string, input: {
    name: string
    description?: string
    rules: WafRuleUpdate[]
  }) => Promise<unknown>
}

export type OpenApiWafTarget = {
  hostname: string
  zoneId: string
}

export function assertOpenApiWafVerifySecret(secret: string | undefined, authSecret?: string): string {
  if (!secret || !/^[A-Za-z0-9_-]{32,128}$/.test(secret)) {
    throw new Error("OPENAPI_WAF_VERIFY_SECRET must be a 32–128 character URL-safe secret when CUSTOM_DOMAIN is set.")
  }
  if (authSecret && secret === authSecret) {
    throw new Error("OPENAPI_WAF_VERIFY_SECRET must be different from AUTH_SECRET because it is visible to Zone WAF readers.")
  }
  return secret
}

function openApiPathExpression() {
  return '(http.request.uri.path eq "/api/config") or (http.request.uri.path eq "/api/emails") or starts_with(http.request.uri.path, "/api/emails/")'
}

function skipActionParameters() {
  return {
    ruleset: "current",
    phases: [...SKIP_PHASES],
    products: [...SKIP_PRODUCTS],
  } satisfies WafSkipActionParameters
}

export function createOpenApiWafRules(hostname: string, verificationSecret: string): WafRuleUpdate[] {
  const hostMatch = `http.host eq ${JSON.stringify(hostname)}`
  const pathsMatch = `(${openApiPathExpression()})`
  const verificationHeaderValue = `http.request.headers[${JSON.stringify(OPENAPI_WAF_VERIFY_HEADER)}][0]`
  const verificationSecretExpression = `${verificationHeaderValue} eq ${JSON.stringify(verificationSecret)}`

  return [
    {
      ref: OPENAPI_WAF_VERIFY_RULE_REF,
      description: "NextMail deployment-only verification bypass for the configured project hostname",
      expression: `(${hostMatch}) and (${verificationSecretExpression})`,
      action: "skip",
      action_parameters: skipActionParameters(),
      enabled: true,
      logging: { enabled: false },
    },
    {
      ref: OPENAPI_WAF_RULE_REF,
      description: "NextMail OpenAPI WAF bypass for the configured project hostname",
      expression: `(${hostMatch}) and ${pathsMatch}`,
      action: "skip",
      action_parameters: skipActionParameters(),
      enabled: true,
      logging: { enabled: true },
    },
  ]
}

function stripServerManagedRuleFields(rule: WafRule): WafRuleUpdate {
  const { last_updated: _lastUpdated, version: _version, categories: _categories, ...writableRule } = rule
  return writableRule
}

function cloudflareErrorStatus(error: unknown) {
  if (!error || typeof error !== "object" || !("status" in error)) return ""
  const status = (error as { status?: unknown }).status
  return typeof status === "number" ? ` (HTTP ${status})` : ""
}

async function getEntryPoint(api: WafEntryPointApi, zoneId: string) {
  try {
    return await api.getEntryPoint(zoneId)
  } catch (error) {
    throw new Error(`Cloudflare WAF ruleset read failed${cloudflareErrorStatus(error)}. Confirm the token has WAF: Read permission for this Zone.`)
  }
}

export async function configureOpenApiWaf(
  api: WafEntryPointApi,
  target: OpenApiWafTarget,
  verificationSecret: string,
): Promise<void> {
  const current = await getEntryPoint(api, target.zoneId)
  const managedRefs = new Set([OPENAPI_WAF_RULE_REF, OPENAPI_WAF_VERIFY_RULE_REF])
  const currentManagedRules = new Map((current?.rules ?? []).filter(rule => rule.ref && managedRefs.has(rule.ref)).map(rule => [rule.ref!, rule]))
  const preservedRules = (current?.rules ?? [])
    .filter(rule => !rule.ref || !managedRefs.has(rule.ref))
    .map(stripServerManagedRuleFields)
  const managedRules = createOpenApiWafRules(target.hostname, verificationSecret).map(rule => {
    const existingId = currentManagedRules.get(rule.ref!)?.id
    return existingId ? { ...rule, id: existingId } : rule
  })

  try {
    await api.updateEntryPoint(target.zoneId, {
      name: current?.name || "NextMail project-scoped OpenAPI rules",
      ...(current?.description ? { description: current.description } : {}),
      rules: [...managedRules, ...preservedRules],
    })
  } catch (error) {
    throw new Error(`Cloudflare WAF ruleset update failed${cloudflareErrorStatus(error)}. Confirm the token has WAF: Edit permission for this Zone.`)
  }

  await verifyOpenApiWaf(api, target, verificationSecret)
}

function sameStringSet(value: unknown, expected: readonly string[]) {
  if (!Array.isArray(value) || !value.every(item => typeof item === "string")) return false
  return value.length === expected.length && expected.every(item => value.includes(item))
}

function isExpectedSkipRule(
  rule: { action?: string; action_parameters?: unknown; enabled?: boolean; expression?: string; logging?: { enabled?: boolean } } | undefined,
  expected: WafRuleUpdate,
) {
  if (!rule || rule.action !== "skip" || rule.enabled !== true || rule.expression !== expected.expression) return false
  const params = rule.action_parameters
  if (!params || typeof params !== "object") return false
  const skipParams = params as Record<string, unknown>
  if (skipParams.ruleset !== "current") return false
  if (!sameStringSet(skipParams.phases, SKIP_PHASES) || !sameStringSet(skipParams.products, SKIP_PRODUCTS)) return false
  if (skipParams.rules !== undefined || skipParams.rulesets !== undefined || skipParams.phase !== undefined) return false
  const loggingEnabled = rule.logging?.enabled
  return loggingEnabled === expected.logging?.enabled
}

export async function verifyOpenApiWaf(
  api: WafEntryPointApi,
  target: OpenApiWafTarget,
  verificationSecret: string,
): Promise<void> {
  const entryPoint = await getEntryPoint(api, target.zoneId)
  const rules = entryPoint?.rules ?? []
  const expectedRules = createOpenApiWafRules(target.hostname, verificationSecret)

  if (rules[0]?.ref !== OPENAPI_WAF_VERIFY_RULE_REF || rules[1]?.ref !== OPENAPI_WAF_RULE_REF) {
    throw new Error(`OpenAPI WAF rule ordering verification failed for ${target.hostname}.`)
  }

  for (const expected of expectedRules) {
    const matchingRules = rules.filter(rule => rule.ref === expected.ref)
    if (matchingRules.length !== 1 || !isExpectedSkipRule(matchingRules[0], expected)) {
      throw new Error(`OpenAPI WAF rule verification failed for ${target.hostname} (${expected.ref}).`)
    }
  }
}
