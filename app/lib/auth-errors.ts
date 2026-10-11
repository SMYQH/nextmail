const credentialErrorMessages = {
  username_taken: "errors.usernameTaken",
  invalid_input: "errors.invalidInput",
  verification_required: "toast.turnstileRequiredDesc",
  verification_failed: "errors.verificationFailed",
  invalid_credentials: "toast.loginFailedDesc",
} as const

export type CredentialErrorCode = keyof typeof credentialErrorMessages

export function getAuthErrorMessage(error?: string, code?: string) {
  if (error === "CredentialsSignin" && code && Object.hasOwn(credentialErrorMessages, code)) {
    return credentialErrorMessages[code as CredentialErrorCode]
  }
  return "toast.registerFailedDesc"
}
