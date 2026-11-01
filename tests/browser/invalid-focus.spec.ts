import { expect, test } from '@playwright/test'
import { AUTH_COPY } from './support'

test.use({ serviceWorkers: 'block' })

for (const locale of ['en', 'zh-CN'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${locale} invalid fields keep a destructive focus cue in ${theme}`, async ({ page }, testInfo) => {
      await page.addInitScript(value => localStorage.setItem('temp-mail-theme', value), theme)
      await page.goto(`/${locale}/login`)
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`))
      const copy = AUTH_COPY[locale]
      const panel = page.getByRole('tabpanel')
      const username = panel.getByPlaceholder(copy.username, { exact: true })
      const password = panel.getByPlaceholder(copy.password, { exact: true })

      await panel.getByRole('button', { name: copy.loginButton, exact: true }).click()
      await expect(username).toHaveAttribute('aria-invalid', 'true')
      await expect(password).toHaveAttribute('aria-invalid', 'true')

      const tokens = await page.evaluate(() => {
        const read = (name: string) => {
          const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
          const probe = document.createElement('div')
          probe.style.color = `hsl(${value})`
          document.body.appendChild(probe)
          const color = getComputedStyle(probe).color
          probe.remove()
          return color
        }
        return { destructive: read('--destructive'), primary: read('--primary') }
      })

      await username.focus()
      await expect(username).toBeFocused()
      // The border colour animates, so wait for the settled value instead of reading it once.
      await expect.poll(
        () => username.evaluate(node => getComputedStyle(node).borderBottomColor),
        { message: 'the focus underline must use the destructive token' }
      ).toBe(tokens.destructive)
      await expect.poll(
        () => username.evaluate(node => getComputedStyle(node).borderTopColor),
        { message: 'the destructive border treatment must be preserved' }
      ).toBe(tokens.destructive)
      const shadow = await username.evaluate(node => getComputedStyle(node).boxShadow)
      expect(shadow, 'the focus cue must be drawn in the destructive token').toContain('inset')
      const focused = await username.evaluate(node => getComputedStyle(node).borderBottomColor)
      expect(focused, 'the focus underline must not use the primary token').not.toBe(tokens.primary)

      // A valid field keeps the primary focus cue.
      await password.fill('password123')
      await username.fill('valid_user')
      await expect(username).not.toHaveAttribute('aria-invalid', 'true')
      await username.focus()
      await expect.poll(
        () => username.evaluate(node => getComputedStyle(node).borderBottomColor),
        { message: 'a valid field keeps the primary focus underline' }
      ).toBe(tokens.primary)
      await page.screenshot({ path: testInfo.outputPath(`${locale}-${theme}-invalid-focus.png`), animations: 'disabled' })
    })
  }
}
