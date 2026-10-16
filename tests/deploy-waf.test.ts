import test from "node:test"
import assert from "node:assert/strict"
import {
  assertOpenApiWafVerifySecret,
  configureOpenApiWaf,
  createOpenApiWafRules,
  OPENAPI_WAF_RULE_REF,
  OPENAPI_WAF_VERIFY_HEADER,
  OPENAPI_WAF_VERIFY_RULE_REF,
  verifyOpenApiWaf,
  type WafEntryPoint,
  type WafEntryPointApi,
} from "../scripts/deploy/waf-config"
import { verifyOpenApiHttpBehavior } from "../scripts/deploy/waf-runtime-verification"

const hostname = "app.example.invalid"
const zoneId = "zone-project"
const secret = "0123456789abcdef0123456789abcdef"

test("verification secret must be separate, URL-safe, and long enough for deployment use", () => {
  assert.equal(assertOpenApiWafVerifySecret(secret), secret)
  assert.equal(assertOpenApiWafVerifySecret(secret, "a-different-auth-secret"), secret)
  assert.throws(() => assertOpenApiWafVerifySecret(undefined), /32–128 character URL-safe secret/)
  assert.throws(() => assertOpenApiWafVerifySecret("short"), /32–128 character URL-safe secret/)
  assert.throws(() => assertOpenApiWafVerifySecret(`${secret}!`), /32–128 character URL-safe secret/)
  assert.throws(() => assertOpenApiWafVerifySecret(secret, secret), /must be different from AUTH_SECRET/)
})

test("OpenAPI skip rules match only the configured hostname and documented API paths without skipping rate limits", () => {
  const [verificationRule, openApiRule] = createOpenApiWafRules(hostname, secret)

  assert.equal(openApiRule.ref, OPENAPI_WAF_RULE_REF)
  assert.match(openApiRule.expression!, /http\.host eq "app\.example\.invalid"/)
  assert.match(openApiRule.expression!, /http\.request\.uri\.path eq "\/api\/config"/)
  assert.match(openApiRule.expression!, /starts_with\(http\.request\.uri\.path, "\/api\/emails\/"\)/)
  assert.equal(verificationRule.ref, OPENAPI_WAF_VERIFY_RULE_REF)
  assert.match(verificationRule.expression!, /http\.host eq "app\.example\.invalid"/)
  assert.match(verificationRule.expression!, /http\.request\.headers\["x-nextmail-waf-verify"\]\[0\] eq "0123456789abcdef0123456789abcdef"/)
  assert.ok(!verificationRule.expression!.includes("http.request.uri.path"))

  for (const rule of [openApiRule, verificationRule]) {
    assert.equal(rule.action, "skip")
    assert.equal(rule.enabled, true)
    assert.deepEqual(rule.action_parameters, {
      ruleset: "current",
      phases: ["http_request_firewall_managed", "http_request_sbfm"],
      products: ["bic", "hot", "securityLevel", "uaBlock", "waf", "zoneLockdown"],
    })
    assert.ok(!JSON.stringify(rule.action_parameters).includes("http_ratelimit"))
    assert.ok(!JSON.stringify(rule.action_parameters).includes("rateLimit"))
  }
  assert.equal(verificationRule.logging?.enabled, false)
})

test("WAF configuration upserts project rules first, preserves unrelated rules, and stays idempotent", async () => {
  const unrelatedRule = {
    id: "operator-rule-id",
    ref: "operator_custom_rule",
    action: "block" as const,
    enabled: true,
    description: "Operator-maintained restriction",
    expression: 'http.host eq "other.example.invalid"',
    logging: { enabled: false },
    last_updated: "2026-01-01T00:00:00Z",
    version: "3",
    categories: ["operator"],
  }
  const legacyOpenApiRule = { ...createOpenApiWafRules("old.example.invalid", secret)[1], id: "old-managed-rule", last_updated: "2026-01-01T00:00:00Z", version: "3" }
  let entryPoint: WafEntryPoint = {
    name: "Existing zone rules",
    description: "Keep this description",
    rules: [unrelatedRule, legacyOpenApiRule, { ...unrelatedRule, ref: "operator_second_rule", id: "operator-second" }],
  }
  const updates: Array<Parameters<WafEntryPointApi["updateEntryPoint"]>[1]> = []
  const api: WafEntryPointApi = {
    getEntryPoint: async requestedZone => {
      assert.equal(requestedZone, zoneId)
      return entryPoint
    },
    updateEntryPoint: async (requestedZone, input) => {
      assert.equal(requestedZone, zoneId)
      updates.push(input)
      entryPoint = {
        ...input,
        rules: input.rules.map(rule => ({ ...rule, last_updated: "2026-01-01T00:00:00Z", version: "3" })),
      }
    },
  }

  await configureOpenApiWaf(api, { hostname, zoneId }, secret)

  assert.equal(updates.length, 1)
  assert.equal(entryPoint.name, "Existing zone rules")
  assert.equal(entryPoint.description, "Keep this description")
  assert.deepEqual(entryPoint.rules?.map(rule => rule.ref), [
    OPENAPI_WAF_VERIFY_RULE_REF,
    OPENAPI_WAF_RULE_REF,
    "operator_custom_rule",
    "operator_second_rule",
  ])
  assert.deepEqual(entryPoint.rules?.[2], {
    id: "operator-rule-id",
    ref: "operator_custom_rule",
    action: "block",
    enabled: true,
    description: "Operator-maintained restriction",
    expression: 'http.host eq "other.example.invalid"',
    logging: { enabled: false },
    last_updated: "2026-01-01T00:00:00Z",
    version: "3",
  })
  assert.equal(entryPoint.rules?.[1].id, "old-managed-rule")

  await configureOpenApiWaf(api, { hostname, zoneId }, secret)

  assert.equal(updates.length, 2)
  assert.equal(entryPoint.rules?.length, 4)
  await verifyOpenApiWaf(api, { hostname, zoneId }, secret)
})

test("WAF verification rejects a rule that starts skipping rate limiting", async () => {
  const rules = createOpenApiWafRules(hostname, secret)
  const actionParameters = rules[0].action_parameters as { ruleset: "current"; phases: string[]; products: string[] }
  actionParameters.phases = ["http_request_firewall_managed", "http_request_sbfm", "http_ratelimit"]
  const readRules = rules.map(rule => ({ ...rule, last_updated: "2026-01-01T00:00:00Z", version: "3" }))
  const api: WafEntryPointApi = {
    getEntryPoint: async () => ({ rules: readRules }),
    updateEntryPoint: async () => assert.fail("verification must not update the ruleset"),
  }

  await assert.rejects(verifyOpenApiWaf(api, { hostname, zoneId }, secret), /OpenAPI WAF rule verification failed/)
})

test("WAF verification rejects owned skip rules placed after unrelated blocking rules", async () => {
  const rules = createOpenApiWafRules(hostname, secret)
  const readRules = rules.map(rule => ({ ...rule, last_updated: "2026-01-01T00:00:00Z", version: "3" }))
  const api: WafEntryPointApi = {
    getEntryPoint: async () => ({ rules: [{ ref: "operator_block", action: "block", last_updated: "2026-01-01T00:00:00Z", version: "3", expression: "true", enabled: true }, ...readRules] }),
    updateEntryPoint: async () => assert.fail("verification must not update the ruleset"),
  }

  await assert.rejects(verifyOpenApiWaf(api, { hostname, zoneId }, secret), /rule ordering verification failed/)
})

test("Cloudflare ruleset errors never expose the verification secret", async () => {
  const api: WafEntryPointApi = {
    getEntryPoint: async () => null,
    updateEntryPoint: async () => { throw new Error(`API rejected expression containing ${secret}`) },
  }

  await assert.rejects(configureOpenApiWaf(api, { hostname, zoneId }, secret), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /WAF ruleset update failed/)
    assert.ok(!error.message.includes(secret))
    return true
  })

  const readFailureApi: WafEntryPointApi = {
    getEntryPoint: async () => { throw new Error(`API response included ${secret}`) },
    updateEntryPoint: async () => assert.fail("read failures must not update the ruleset"),
  }
  await assert.rejects(verifyOpenApiWaf(readFailureApi, { hostname, zoneId }, secret), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /WAF ruleset read failed/)
    assert.ok(!error.message.includes(secret))
    return true
  })
})

test("post-deployment probes verify API auth and front-end HTML without sending the secret to the app config endpoint", async () => {
  const requests: Array<{ url: string; headers: Headers }> = []
  const fetchMock: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers)
    requests.push({ url: String(input), headers })
    if (String(input).endsWith("/en")) {
      return new Response("<!doctype html><html><body>NextMail</body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    }
    return new Response(JSON.stringify({ error: "未授权" }), {
      status: 401,
      headers: { "content-type": "application/json; charset=utf-8" },
    })
  }

  await verifyOpenApiHttpBehavior({ hostname, zoneId }, secret, fetchMock)

  assert.deepEqual(requests.map(request => request.url), [
    "https://app.example.invalid/api/config",
    "https://app.example.invalid/api/emails",
    "https://app.example.invalid/en",
  ])
  assert.equal(requests[0].headers.has(OPENAPI_WAF_VERIFY_HEADER), false)
  assert.equal(requests[1].headers.get(OPENAPI_WAF_VERIFY_HEADER), secret)
  assert.equal(requests[1].headers.has("x-api-key"), false)
  assert.equal(requests[2].headers.get(OPENAPI_WAF_VERIFY_HEADER), secret)
})

test("post-deployment verification fails clearly when Cloudflare still serves a challenge", async () => {
  const fetchMock: typeof fetch = async () => new Response("challenge body", {
    status: 403,
    headers: { "cf-mitigated": "challenge", "content-type": "text/html" },
  })

  await assert.rejects(
    verifyOpenApiHttpBehavior({ hostname, zoneId }, secret, fetchMock, async () => {}),
    error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /Cloudflare still challenged/)
      assert.ok(!error.message.includes(secret))
      return true
    },
  )
})

test("front-end verification accepts successful HTML with Cloudflare detection scripts", async () => {
  const requests: string[] = []
  const fetchMock: typeof fetch = async input => {
    requests.push(String(input))
    if (String(input).endsWith("/en")) {
      return new Response('<!doctype html><html><body>NextMail<script src="/cdn-cgi/challenge-platform/scripts/precursor/main.js"></script></body></html>', {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    }
    return new Response(JSON.stringify({ error: "未授权" }), { status: 401, headers: { "content-type": "application/json" } })
  }

  await verifyOpenApiHttpBehavior({ hostname, zoneId }, secret, fetchMock, async () => assert.fail("successful HTML must not be retried"))
  assert.equal(requests.length, 3)
})

test("post-deployment HTTP verification retries transient edge responses a bounded number of times", async () => {
  let attempts = 0
  const delays: number[] = []
  const fetchMock: typeof fetch = async input => {
    attempts++
    if (String(input).endsWith("/api/config") && attempts === 1) return new Response("not ready", { status: 503 })
    if (String(input).endsWith("/en")) {
      return new Response("<!doctype html><html>NextMail</html>", { status: 200, headers: { "content-type": "text/html" } })
    }
    return new Response(JSON.stringify({ error: "未授权" }), { status: 401, headers: { "content-type": "application/json" } })
  }

  await verifyOpenApiHttpBehavior({ hostname, zoneId }, secret, fetchMock, async ms => { delays.push(ms) })

  assert.equal(attempts, 4)
  assert.deepEqual(delays, [750])
})

test("front-end verification fails when the requested page is challenged", async () => {
  const fetchMock: typeof fetch = async input => {
    if (String(input).endsWith("/en")) {
      return new Response("challenge body", { status: 403, headers: { "cf-mitigated": "challenge", "content-type": "text/html" } })
    }
    return new Response(JSON.stringify({ error: "未授权" }), { status: 401, headers: { "content-type": "application/json" } })
  }

  await assert.rejects(
    verifyOpenApiHttpBehavior({ hostname, zoneId }, secret, fetchMock, async () => {}),
    error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /Cloudflare still challenged the front-end/)
      assert.ok(!error.message.includes(secret))
      return true
    },
  )
})
