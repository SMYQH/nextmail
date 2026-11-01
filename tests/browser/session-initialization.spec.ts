import { expect, test, type Page } from "@playwright/test"
import {
  AUTH_COPY,
  PASSWORD,
  collectScriptErrors,
  expectClientSession,
  readSession,
  sessionMarker,
  uniqueUsername,
  type Locale,
} from "./support"

const HEADER_LOGIN_COPY: Record<Locale, string> = {
  en: "Login / Sign Up",
  "zh-CN": "登录/注册",
}

const isHomeForLocale = (locale: Locale) => (url: URL) => (
  url.pathname === `/${locale}` || url.pathname === `/${locale}/`
)

function waitForCredentialsResponse(page: Page) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname === "/api/auth/callback/credentials"
      && response.request().method() === "POST"
  })
}

for (const locale of ["en", "zh-CN"] as const) {
  test(`${locale} initializes Auth.js before credentials and keeps registration/sign-in sessions current`, async ({ page, baseURL }) => {
    const copy = AUTH_COPY[locale]
    const scriptErrors = collectScriptErrors(page)
    let preSubmitSessionRequests: string[] = []
    let capturePreSubmitSessionRequests = true
    let credentialsSubmissions = 0

    if (!baseURL) throw new Error("Playwright baseURL must be set for locale cookie initialization")
    await page.context().addCookies([{ name: "NEXT_LOCALE", value: locale, url: baseURL }])

    page.on("request", (request) => {
      const url = new URL(request.url())
      if (url.pathname === "/api/auth/session" && capturePreSubmitSessionRequests) {
        preSubmitSessionRequests.push(request.method())
      }
      if (url.pathname === "/api/auth/callback/credentials" && request.method() === "POST") {
        credentialsSubmissions += 1
      }
    })

    const username = uniqueUsername()
    await page.goto(`/${locale}/login`)
    await expect(page.getByRole("heading", { name: copy.title })).toBeVisible()
    await page.waitForLoadState("networkidle")

    await page.getByRole("tab", { name: copy.registerTab, exact: true }).click()
    await expect(page.getByPlaceholder(copy.confirmPassword, { exact: true })).toBeVisible()
    await page.getByPlaceholder(copy.username, { exact: true }).fill(username)
    await page.getByPlaceholder(copy.password, { exact: true }).fill(PASSWORD)
    await page.getByPlaceholder(copy.confirmPassword, { exact: true }).fill(PASSWORD)

    expect(preSubmitSessionRequests).toEqual([])
    capturePreSubmitSessionRequests = false
    const registrationResponsePromise = waitForCredentialsResponse(page)
    await page.getByRole("button", { name: copy.registerButton, exact: true }).click()
    await registrationResponsePromise
    await expect(page).toHaveURL(isHomeForLocale(locale), { timeout: 60_000 })
    expect(credentialsSubmissions).toBe(1)
    expect((await readSession(page)).user?.name).toBe(username)
    await expectClientSession(page, locale, scriptErrors)

    await sessionMarker(page, locale).click()
    await expect(page).toHaveURL(isHomeForLocale(locale))
    await expect(page.getByRole("banner").getByRole("button", {
      name: HEADER_LOGIN_COPY[locale],
      exact: true,
    })).toBeVisible()
    const signedOutSessionResponse = await page.request.get("/api/auth/session")
    expect(signedOutSessionResponse.ok()).toBe(true)
    expect(await signedOutSessionResponse.json()).toBeNull()

    preSubmitSessionRequests = []
    capturePreSubmitSessionRequests = true
    await page.goto(`/${locale}/login`)
    await expect(page.getByRole("heading", { name: copy.title })).toBeVisible()
    await page.waitForLoadState("networkidle")
    await page.getByPlaceholder(copy.username, { exact: true }).fill(username)
    await page.getByPlaceholder(copy.password, { exact: true }).fill(PASSWORD)

    expect(preSubmitSessionRequests).toEqual([])
    capturePreSubmitSessionRequests = false
    const signInResponsePromise = waitForCredentialsResponse(page)
    await page.getByRole("button", { name: copy.loginButton, exact: true }).click()
    await signInResponsePromise
    await expect(page).toHaveURL(isHomeForLocale(locale), { timeout: 60_000 })
    expect(credentialsSubmissions).toBe(2)
    expect((await readSession(page)).user?.name).toBe(username)
    await expectClientSession(page, locale, scriptErrors)
  })
}
