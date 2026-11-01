import { expect, test } from "@playwright/test"
import { COMMON_COPY } from "./support"

test.describe("theme toggle", () => {
  test("the root class switches to the dark variant and survives a reload", async ({ page }) => {
    // Pin the system preference so the initial resolved theme is deterministic.
    await page.emulateMedia({ colorScheme: "light" })
    await page.goto("/en")

    const root = page.locator("html")
    await expect(root).toHaveClass(/\blight\b/)

    await page.getByRole("button", { name: COMMON_COPY.en.toggleTheme }).click()
    await expect(root).toHaveClass(/\bdark\b/)
    await expect(root).not.toHaveClass(/\blight\b/)

    await page.reload()
    await expect(root).toHaveClass(/\bdark\b/)
    await expect(root).not.toHaveClass(/\blight\b/)
  })
})
