import { expect, type Page } from "@playwright/test"

/**
 * Shared helpers and copy for the browser suite.
 *
 * Every string below is copied verbatim from the translation files:
 *   - app/i18n/messages/{en,zh-CN}/auth.json   -> auth.loginForm / auth.signButton
 *   - app/i18n/messages/{en,zh-CN}/common.json -> common.actions
 *   - app/i18n/messages/{en,zh-CN}/emails.json -> emails.create
 *
 * Local environment prerequisites (the dev server reads the real local bindings):
 *   - SITE_CONFIG KV needs `EMAIL_DOMAINS`, otherwise no mailbox domain is offered.
 *   - SITE_CONFIG KV needs `DEFAULT_ROLE=duke`, because the mailbox UI is only
 *     rendered for roles that own the MANAGE_EMAIL permission and the default
 *     `civilian` role owns none.
 *
 *   npx wrangler kv key put EMAIL_DOMAINS test.example.com --binding SITE_CONFIG --local --persist-to .wrangler/state
 *   npx wrangler kv key put DEFAULT_ROLE duke --binding SITE_CONFIG --local --persist-to .wrangler/state
 */

export type Locale = "en" | "zh-CN"

export const PASSWORD = "BrowserSuite!2024"

export const AUTH_COPY = {
  en: {
    title: "Welcome to NextMail",
    subtitle: "Cute Temporary Email Service (。・∀・)ノ",
    loginTab: "Login",
    registerTab: "Sign Up",
    username: "Username",
    password: "Password",
    confirmPassword: "Confirm Password",
    loginButton: "Login",
    registerButton: "Sign Up",
    logout: "Logout",
    usernameTaken: "This username is already taken. Choose a different username or log in.",
  },
  "zh-CN": {
    title: "欢迎使用 NextMail",
    subtitle: "下一代临时邮箱服务",
    loginTab: "登录",
    registerTab: "注册",
    username: "用户名",
    password: "密码",
    confirmPassword: "确认密码",
    loginButton: "登录",
    registerButton: "注册",
    logout: "登出",
    usernameTaken: "用户名已存在，请更换用户名或直接登录。",
  },
} as const satisfies Record<Locale, Record<string, string>>

export const MAILBOX_COPY = {
  en: {
    createEmail: "Create Email",
    namePlaceholder: "Leave empty for random generation",
    expiryTime: "Validity Period",
    oneHour: "1 Hour",
    oneDay: "1 Day",
    threeDays: "3 Days",
    permanent: "Permanent",
    create: "Create",
    cancel: "Cancel",
    noPermission: "Awaiting Role Assignment",
  },
  "zh-CN": {
    createEmail: "创建邮箱",
    namePlaceholder: "留空则随机生成",
    expiryTime: "有效期",
    oneHour: "1 小时",
    oneDay: "1 天",
    threeDays: "3 天",
    permanent: "永久",
    create: "创建",
    cancel: "取消",
    noPermission: "等待角色分配",
  },
} as const satisfies Record<Locale, Record<string, string>>

export const COMMON_COPY = {
  en: { toggleTheme: "Toggle theme", refresh: "Refresh" },
  "zh-CN": { toggleTheme: "切换主题", refresh: "刷新" },
} as const satisfies Record<Locale, Record<string, string>>

/**
 * Builds a username that satisfies the credential schema
 * (1-20 characters from `[a-zA-Z0-9_-]`) and is unique per call, so repeated
 * runs against the same local D1 never collide.
 */
export function uniqueUsername(): string {
  const stamp = Date.now().toString(36)
  const salt = Math.random().toString(36).slice(2, 6)
  return `pw_${stamp}_${salt}`
}

function isHomePath(locale: Locale) {
  return (url: URL) => url.pathname === `/${locale}` || url.pathname === `/${locale}/`
}

/**
 * Tells a transport hiccup apart from a failed request.
 *
 * A cold dev server compiles a route while the request is in flight and can
 * reset the connection. That says nothing about the endpoint, so only
 * connection level errors are retried.
 */
function isTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|ERR_STREAM|terminated/i.test(message)
}

/** The user part of the session payload the specs replay into mocked responses. */
export interface BrowserSessionUser extends Record<string, unknown> {
  name?: string
}

/** The session payload the specs replay into the mocked API responses. */
export interface BrowserSession extends Record<string, unknown> {
  user?: BrowserSessionUser
}

/**
 * Reads the session over the API.
 *
 * The read is idempotent, so a connection that the dev server reset while it
 * compiled the route can be retried. A response that arrives is never
 * retried: a non-ok status or a broken session still fails the test.
 */
export async function readSession(page: Page): Promise<BrowserSession> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await page.request.get('/api/auth/session')
      expect(response.ok()).toBe(true)
      return await response.json() as BrowserSession
    } catch (error) {
      if (!isTransportError(error)) throw error
      lastError = error
    }
  }
  throw lastError
}

/**
 * The client session marker in the header.
 *
 * The profile page renders a second "Logout" button inside the profile card,
 * so the marker has to be scoped to the banner to stay unambiguous.
 */
export function sessionMarker(page: Page, locale: Locale) {
  return page.getByRole("banner").getByRole("button", { name: AUTH_COPY[locale].logout, exact: true })
}

/**
 * Collects script errors and failed chunks so hydration failures are explicit.
 * The readiness check reports them without silently reloading or clearing them.
 */
export function collectScriptErrors(page: Page): string[] {
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.stack || `${error.name}: ${error.message}`))
  page.on("requestfailed", request => {
    // A chunk that cannot be loaded leaves the page unhydrated.
    if (request.url().includes("/_next/static/chunks/")) errors.push(`requestfailed: ${request.url()}`)
  })
  return errors
}

/** Waits for hydration without reloading away session loss or script errors. */
export async function expectClientReady(page: Page, locale: Locale, scriptErrors: string[] = []) {
  expect(scriptErrors, `the page must not raise client errors: ${scriptErrors.join(' | ')}`).toEqual([])
  await expect(sessionMarker(page, locale)).toBeVisible({ timeout: 30_000 })
  expect(scriptErrors, `the page must not raise client errors: ${scriptErrors.join(' | ')}`).toEqual([])
}

/** The session marker, the profile panels and the mailbox panes share one wait. */
export const expectProfileReady = expectClientReady
export const expectClientSession = expectClientReady

/**
 * Register through the real UI, verify the fresh session, then select the locale.
 *
 * The script errors are collected in the array the caller passes in, so a
 * caller can hand the same array to `expectProfileReady` afterwards.
 */
export async function registerThroughUi(page: Page, locale: Locale, scriptErrors: string[] = collectScriptErrors(page)): Promise<string> {
  const copy = AUTH_COPY[locale]
  const username = uniqueUsername()

  await page.goto(`/${locale}/login`)
  await page.getByRole("tab", { name: copy.registerTab }).click()
  await page.getByPlaceholder(copy.username, { exact: true }).fill(username)
  await page.getByPlaceholder(copy.password, { exact: true }).fill(PASSWORD)
  await page.getByPlaceholder(copy.confirmPassword, { exact: true }).fill(PASSWORD)
  await page.getByRole("button", { name: copy.registerButton }).click()

  // Registration redirects through `/`, whose locale need not match the form.
  await expect(page).toHaveURL(url => /^\/(en|zh-CN)\/?$/.test(url.pathname), { timeout: 60_000 })
  const session = await readSession(page)
  expect(session.user?.name).toBe(username)

  await page.goto(`/${locale}`)
  await expect(page).toHaveURL(isHomePath(locale))
  await expectClientSession(page, locale, scriptErrors)
  return username
}

/** Reads the horizontal overflow of the document root. */
export async function readHorizontalOverflow(page: Page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
}
