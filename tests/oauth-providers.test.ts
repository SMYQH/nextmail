import assert from "node:assert/strict"
import test from "node:test"
import {
  getOAuthProviderAvailability,
  type OAuthEnvironment,
} from "../app/lib/oauth-providers"

test("OAuth providers require both non-empty credentials", () => {
  const base: OAuthEnvironment = {
    AUTH_GITHUB_ID: "github-client-id",
    AUTH_GITHUB_SECRET: "github-client-secret",
    AUTH_GOOGLE_ID: "google-client-id",
    AUTH_GOOGLE_SECRET: "google-client-secret",
  }

  assert.deepEqual(getOAuthProviderAvailability(base), {
    github: true,
    google: true,
  })

  assert.deepEqual(getOAuthProviderAvailability({}), {
    github: false,
    google: false,
  })

  assert.deepEqual(
    getOAuthProviderAvailability({
      ...base,
      AUTH_GITHUB_SECRET: "   ",
      AUTH_GOOGLE_ID: "",
    }),
    { github: false, google: false },
  )
})

test("OAuth provider availability is independent per provider", () => {
  assert.deepEqual(
    getOAuthProviderAvailability({
      AUTH_GITHUB_ID: "github-client-id",
      AUTH_GITHUB_SECRET: "github-client-secret",
      AUTH_GOOGLE_ID: "google-client-id",
    }),
    { github: true, google: false },
  )
})
