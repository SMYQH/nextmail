import { expect, test } from "@playwright/test"
import { AUTH_COPY } from "./support"

/**
 * Collects everything the login page shows to the user: the rendered text plus
 * the placeholder of every input, because the login fields carry no label.
 */
async function readLoginSurface(page: import("@playwright/test").Page) {
  const text = await page.locator("body").innerText()
  const placeholders = await page
    .locator("input")
    .evaluateAll(inputs => inputs.map(input => input.getAttribute("placeholder") ?? ""))
  return `${text}\n${placeholders.join("\n")}`
}

test.describe("login page localization", () => {
  test("the English login page renders its own title, subtitle and both tabs", async ({ page }) => {
    await page.goto("/en/login")

    await expect(page.getByRole("heading", { name: AUTH_COPY.en.title })).toBeVisible()
    await expect(page.getByText(AUTH_COPY.en.subtitle, { exact: true })).toBeVisible()
    await expect(page.getByRole("tab", { name: AUTH_COPY.en.loginTab })).toBeVisible()
    await expect(page.getByRole("tab", { name: AUTH_COPY.en.registerTab })).toBeVisible()
    await expect(page.getByPlaceholder(AUTH_COPY.en.username, { exact: true })).toBeVisible()
    await expect(page.getByPlaceholder(AUTH_COPY.en.password, { exact: true })).toBeVisible()
  })

  test("the English login page shows no Chinese login copy", async ({ page }) => {
    await page.goto("/en/login")
    const surface = await readLoginSurface(page)

    const forbidden = [
      AUTH_COPY["zh-CN"].title,
      AUTH_COPY["zh-CN"].subtitle,
      AUTH_COPY["zh-CN"].loginTab,
      AUTH_COPY["zh-CN"].registerTab,
      AUTH_COPY["zh-CN"].username,
      AUTH_COPY["zh-CN"].password,
      AUTH_COPY["zh-CN"].confirmPassword,
    ]
    for (const text of forbidden) {
      expect(surface, `English login page must not contain "${text}"`).not.toContain(text)
    }
  })

  test("the Chinese login page renders its own title, subtitle and both tabs", async ({ page }) => {
    await page.goto("/zh-CN/login")

    await expect(page.getByRole("heading", { name: AUTH_COPY["zh-CN"].title })).toBeVisible()
    await expect(page.getByText(AUTH_COPY["zh-CN"].subtitle, { exact: true })).toBeVisible()
    await expect(page.getByRole("tab", { name: AUTH_COPY["zh-CN"].loginTab })).toBeVisible()
    await expect(page.getByRole("tab", { name: AUTH_COPY["zh-CN"].registerTab })).toBeVisible()
    await expect(page.getByPlaceholder(AUTH_COPY["zh-CN"].username, { exact: true })).toBeVisible()
    await expect(page.getByPlaceholder(AUTH_COPY["zh-CN"].password, { exact: true })).toBeVisible()
  })

  test("the Chinese login page shows no English login copy", async ({ page }) => {
    await page.goto("/zh-CN/login")
    const surface = await readLoginSurface(page)

    const forbidden = [
      AUTH_COPY.en.title,
      AUTH_COPY.en.subtitle,
      AUTH_COPY.en.loginTab,
      AUTH_COPY.en.registerTab,
      AUTH_COPY.en.username,
      AUTH_COPY.en.password,
      AUTH_COPY.en.confirmPassword,
    ]
    for (const text of forbidden) {
      expect(surface, `Chinese login page must not contain "${text}"`).not.toContain(text)
    }
  })
})
