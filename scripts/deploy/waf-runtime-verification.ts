import {
  OPENAPI_WAF_VERIFY_HEADER,
  type OpenApiWafTarget,
} from "./waf-config"

const MAX_ATTEMPTS = 4
const RETRY_DELAYS_MS = [750, 1_750, 3_500]
const REQUEST_TIMEOUT_MS = 8_000

async function assertUnauthenticatedApiResponse(response: Response, url: string) {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
  const body = await response.text()
  const looksLikeChallenge = response.headers.get("cf-mitigated") === "challenge"

  if (looksLikeChallenge) {
    throw new Error(`Cloudflare still challenged the OpenAPI verification request to ${url}.`)
  }

  if (response.status !== 401 || !contentType.includes("application/json")) {
    throw new Error(`OpenAPI verification request to ${url} returned HTTP ${response.status}; expected the application's unauthenticated JSON response (401).`)
  }

  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    throw new Error(`OpenAPI verification request to ${url} returned invalid JSON.`)
  }

  if (!payload || typeof payload !== "object" || !("error" in payload) || (payload as { error?: unknown }).error !== "未授权") {
    throw new Error(`OpenAPI verification request to ${url} did not return the expected application authorization response.`)
  }
}

async function assertFrontendResponse(response: Response, url: string) {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
  await response.text()
  // Cloudflare can inject detection scripts into successful application HTML.
  // Its documented challenge header distinguishes a blocking Challenge Page.
  const looksLikeChallenge = response.headers.get("cf-mitigated") === "challenge"

  if (looksLikeChallenge) {
    throw new Error(`Cloudflare still challenged the front-end verification request to ${url}.`)
  }

  if (response.status !== 200 || !contentType.includes("text/html")) {
    throw new Error(`Front-end verification request to ${url} returned HTTP ${response.status}; expected an HTML page (200).`)
  }
}

function isTransientEdgeResponse(status: number) {
  return status === 404 || status === 408 || status === 425 || (status >= 500 && status <= 599)
}

async function requestWithEdgeRetries(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  wait: (milliseconds: number) => Promise<void>,
) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const challenge = response.headers.get("cf-mitigated") === "challenge"
      const transient = challenge || isTransientEdgeResponse(response.status)

      if (!transient || attempt === MAX_ATTEMPTS - 1) return response
      await response.body?.cancel()
    } catch (error) {
      if (attempt === MAX_ATTEMPTS - 1) {
        throw new Error(`OpenAPI WAF verification could not reach ${url} after ${MAX_ATTEMPTS} attempts (${error instanceof Error ? error.name : "network error"}).`)
      }
    }

    await wait(RETRY_DELAYS_MS[attempt])
  }

  throw new Error(`OpenAPI WAF verification could not reach ${url}.`)
}

export async function verifyOpenApiHttpBehavior(
  target: OpenApiWafTarget,
  verificationSecret: string,
  fetchImpl: typeof fetch = fetch,
  wait: (milliseconds: number) => Promise<void> = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
): Promise<void> {
  const origin = `https://${target.hostname}`
  const unauthenticatedConfigUrl = `${origin}/api/config`
  const verificationApiUrl = `${origin}/api/emails`
  const verificationPageUrl = `${origin}/en`

  const configResponse = await requestWithEdgeRetries(fetchImpl, unauthenticatedConfigUrl, {
    method: "GET",
    headers: { Accept: "application/json" },
    redirect: "manual",
    cache: "no-store",
  }, wait)
  await assertUnauthenticatedApiResponse(configResponse, unauthenticatedConfigUrl)

  const protectedResponse = await requestWithEdgeRetries(fetchImpl, verificationApiUrl, {
    method: "GET",
    headers: {
      Accept: "application/json",
      [OPENAPI_WAF_VERIFY_HEADER]: verificationSecret,
    },
    redirect: "manual",
    cache: "no-store",
  }, wait)
  await assertUnauthenticatedApiResponse(protectedResponse, verificationApiUrl)

  const pageResponse = await requestWithEdgeRetries(fetchImpl, verificationPageUrl, {
    method: "GET",
    headers: {
      Accept: "text/html",
      [OPENAPI_WAF_VERIFY_HEADER]: verificationSecret,
    },
    redirect: "manual",
    cache: "no-store",
  }, wait)
  await assertFrontendResponse(pageResponse, verificationPageUrl)
}
