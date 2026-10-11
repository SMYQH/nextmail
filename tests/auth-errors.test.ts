import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { locales } from "../app/i18n/config"
import { getAuthErrorMessage, type CredentialErrorCode } from "../app/lib/auth-errors"

// Explicit expectations catch accidental fallback to a generic message for a known code.
const expectedMessages = {
  username_taken: "errors.usernameTaken",
  invalid_input: "errors.invalidInput",
  verification_required: "toast.turnstileRequiredDesc",
  verification_failed: "errors.verificationFailed",
  invalid_credentials: "toast.loginFailedDesc",
} satisfies Record<CredentialErrorCode, string>

test("known credential errors select the intended user-facing messages", () => {
  for (const [code, message] of Object.entries(expectedMessages)) {
    assert.equal(getAuthErrorMessage("CredentialsSignin", code), message, code)
  }
})

for (const locale of locales) {
  test(`auth messages are nonempty in the supported locale ${locale}`, () => {
    const { loginForm } = JSON.parse(readFileSync(new URL(`../app/i18n/messages/${locale}/auth.json`, import.meta.url), "utf8"))
    for (const path of [...Object.values(expectedMessages), "toast.registerFailedDesc"]) {
      const [section, key] = path.split(".")
      const value = loginForm[section]?.[key]
      assert.equal(typeof value, "string", `${locale}: ${path}`)
      assert.ok(value.trim().length > 0, `${locale}: ${path} must not be blank`)
    }
  })
}

test("unknown, inherited and non-credential errors always use the safe fallback", () => {
  for (const error of [undefined, "Configuration", "CredentialsSignin"]) {
    for (const code of [undefined, "", "private database error", "unknown", "__proto__", "constructor", "toString"]) {
      assert.equal(getAuthErrorMessage(error, code), "toast.registerFailedDesc")
    }
  }
  for (const code of Object.keys(expectedMessages)) {
    assert.equal(getAuthErrorMessage("Configuration", code), "toast.registerFailedDesc")
  }
})
