import { expect, test } from '@playwright/test'
import { collectScriptErrors, expectClientReady, readSession, registerThroughUi } from './support'

test.use({ serviceWorkers: 'block' })

for (const locale of ['en', 'zh-CN'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${locale} compound sender has keyboard focus in ${theme}`, async ({ page }, testInfo) => {
      await page.emulateMedia({ reducedMotion: theme === 'dark' ? 'reduce' : 'no-preference' })
      await page.addInitScript(value => localStorage.setItem('temp-mail-theme', value), theme)
      const scriptErrors = collectScriptErrors(page)
      await registerThroughUi(page, locale, scriptErrors)
      const session = await readSession(page)
      const address = 'catchall@test.example.com'
      // Only the client permissions and mailbox fixtures are mocked. No mail is sent.
      await page.route('**/api/**', async route => {
        const request = route.request()
        expect(request.method(), 'focus tests must not perform API writes').toBe('GET')
        const path = new URL(request.url()).pathname
        if (path === '/api/auth/session') {
          await route.fulfill({ json: { ...session, user: { ...session.user, roles: [{ name: 'emperor' }] } } })
        } else if (path === '/api/emails/send-permission') {
          await route.fulfill({ json: { canSend: true, enabledDomains: ['test.example.com'] } })
        } else if (path === '/api/emails') {
          await route.fulfill({ json: { emails: [{
            id: 'focus-mailbox', address, createdAt: Date.now(), expiresAt: Date.UTC(9999, 11, 31),
            isCatchAll: true, totalMessages: 0, unreadMessages: 0,
          }], total: 1, nextCursor: null } })
        } else if (path === '/api/emails/focus-mailbox') {
          await route.fulfill({ json: { messages: [], total: 0, unread: 0, nextCursor: null, latestCursor: '0' } })
        } else {
          await route.continue()
        }
      })
      await page.goto(`/${locale}/mailbox`)
      // The mailbox pane renders from the client session.
      await expectClientReady(page, locale, scriptErrors)
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`))
      await page.getByRole('button').filter({ hasText: address }).click()
      const copy = locale === 'en' ? {
        send: 'Send Email', prefix: 'Sender address prefix', recipient: 'Recipient email address',
      } : {
        send: '发送邮件', prefix: '发件地址前缀', recipient: '收件人邮箱地址',
      }
      await page.getByRole('button', { name: copy.send, exact: true }).click()
      const dialog = page.getByRole('dialog')
      const prefix = dialog.getByRole('textbox', { name: copy.prefix, exact: true })
      const recipient = dialog.getByPlaceholder(copy.recipient, { exact: true })
      await expect(prefix).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(recipient).toBeFocused()
      const group = prefix.locator('..')
      const shadow = () => group.evaluate(element => getComputedStyle(element).boxShadow)
      const idleShadow = await shadow()
      await page.keyboard.press('Shift+Tab')
      await expect(prefix).toBeFocused()
      await expect.poll(shadow, { message: 'sender focus must visibly change the compound field ring' }).not.toBe(idleShadow)
      await expect.poll(shadow).not.toBe('none')
      await expect.poll(shadow).toMatch(/2px/)
      await expect(dialog).toHaveCSS('opacity', '1')
      await page.screenshot({ path: testInfo.outputPath(`${locale}-${theme}-sender-focus.png`), animations: 'disabled' })

      await page.keyboard.press('Tab')
      await expect(recipient).toBeFocused()
      await expect.poll(shadow).toBe(idleShadow)
      await page.keyboard.press('Shift+Tab')
      await expect(prefix).toBeFocused()
      await page.emulateMedia({ forcedColors: 'active' })
      await expect(prefix).toHaveCSS('outline-style', 'solid')
      await expect(prefix).toHaveCSS('outline-width', '2px')
      await page.screenshot({ path: testInfo.outputPath(`${locale}-${theme}-forced-colors-focus.png`), animations: 'disabled' })
    })
  }
}
