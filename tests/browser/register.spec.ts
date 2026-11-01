import { expect, test } from "@playwright/test"
import { AUTH_COPY, registerThroughUi } from "./support"

test.describe("registration", () => {
  test("a fresh user registers through the UI and lands on an authenticated page", async ({ page }) => {
    const username = await registerThroughUi(page, "en")

    // The app redirects to the localized home page after a successful sign-up.
    await expect(page).toHaveURL(/\/en\/?($|\?)/)
    await expect(page).not.toHaveURL(/\/login/)

    // The header only renders the logout control for an authenticated session.
    await expect(page.getByRole("button", { name: AUTH_COPY.en.logout })).toBeVisible()
    expect(username).toMatch(/^pw_[a-z0-9_]+$/)
  })
})
