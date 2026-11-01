import { expect, test } from "@playwright/test"
import { MAILBOX_COPY, collectScriptErrors, expectClientReady, readHorizontalOverflow, registerThroughUi, type Locale } from "./support"

const CASES: Array<{ locale: Locale; copy: Record<string, string> }> = [
  { locale: "en", copy: MAILBOX_COPY.en },
  { locale: "zh-CN", copy: MAILBOX_COPY["zh-CN"] },
]

test.describe("mailbox create-email dialog", () => {
  for (const { locale, copy } of CASES) {
    test(`the Create Email dialog opens on /${locale}/mailbox without horizontal overflow`, async ({ page }, testInfo) => {
      const scriptErrors = collectScriptErrors(page)
      await registerThroughUi(page, locale, scriptErrors)
      await page.goto(`/${locale}/mailbox`)
      // The mailbox toolbar renders from the client session.
      await expectClientReady(page, locale, scriptErrors)

      const trigger = page.getByRole("button", { name: copy.createEmail })
      await expect(trigger, "the mailbox toolbar must offer the Create Email action").toBeVisible()
      await trigger.click()

      const dialog = page.getByRole("dialog")
      await expect(dialog).toBeVisible()
      await expect(dialog.getByRole("heading", { name: copy.createEmail })).toBeVisible()
      await expect(dialog.getByPlaceholder(copy.namePlaceholder, { exact: true })).toBeVisible()
      await expect(dialog.getByText(copy.expiryTime, { exact: true })).toBeVisible()
      await expect(dialog.getByText(copy.oneDay, { exact: true })).toBeVisible()
      await expect(dialog.getByRole("button", { name: copy.create, exact: true })).toBeVisible()
      await expect(dialog.getByRole("button", { name: copy.cancel, exact: true })).toBeVisible()

      await expect(dialog).toHaveCSS('opacity', '1')
      await expect.poll(async () => {
        const overflow = await readHorizontalOverflow(page)
        return overflow.scrollWidth <= overflow.clientWidth
      }, { message: 'the document must not overflow horizontally' }).toBe(true)
      await page.screenshot({
        path: testInfo.outputPath(`${locale}-create-email.png`),
        animations: 'disabled',
        fullPage: true,
      })
    })
  }
})
