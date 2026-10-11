const safeErrorTypes = new Set([
  "AdapterError",
  "AbortError",
  "AuthError",
  "CallbackRouteError",
  "DrizzleError",
  "DrizzleQueryError",
  "Error",
  "EventError",
  "EvalError",
  "JWTSessionError",
  "MissingSecret",
  "OAuthProfileParseError",
  "RangeError",
  "ReferenceError",
  "SendRejectedError",
  "SessionTokenError",
  "SignOutError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "WebhookPolicyError",
])

export function safeErrorMetadata(error: unknown): { errorType: string } {
  try {
    if (error instanceof Error) {
      const type = Object.getPrototypeOf(error)?.constructor?.name
      if (typeof type === "string" && safeErrorTypes.has(type)) {
        return { errorType: type }
      }
      return { errorType: "Error" }
    }
  } catch {
    // Malformed error-like values must not prevent the original failure from being handled.
  }

  return { errorType: "UnknownError" }
}
