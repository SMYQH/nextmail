export interface OAuthProviderAvailability {
  github: boolean
  google: boolean
}

export interface OAuthEnvironment {
  AUTH_GITHUB_ID?: string
  AUTH_GITHUB_SECRET?: string
  AUTH_GOOGLE_ID?: string
  AUTH_GOOGLE_SECRET?: string
}

function isConfigured(...values: Array<string | undefined>) {
  return values.every((value) => Boolean(value?.trim()))
}

export function getOAuthProviderAvailability(
  env: OAuthEnvironment = process.env as OAuthEnvironment,
): OAuthProviderAvailability {
  return {
    github: isConfigured(env.AUTH_GITHUB_ID, env.AUTH_GITHUB_SECRET),
    google: isConfigured(env.AUTH_GOOGLE_ID, env.AUTH_GOOGLE_SECRET),
  }
}
