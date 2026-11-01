import { expect, test } from '@playwright/test'
import { collectScriptErrors, expectClientReady, registerThroughUi } from './support'

test.use({ serviceWorkers: 'block' })

for (const locale of ['en', 'zh-CN'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${locale} message failure shows the styled retry state in ${theme}`, async ({ page }, testInfo) => {
      await page.addInitScript(value => localStorage.setItem('temp-mail-theme', value), theme)
      const scriptErrors = collectScriptErrors(page)
      await registerThroughUi(page, locale, scriptErrors)
      const subject = 'Error state fixture subject'
      const address = 'error-state@test.example.com'
      const copy = locale === 'en'
        ? { network: 'Failed to load message details', retry: 'Click to retry' }
        : { network: '获取邮件详情失败', retry: '点击重试' }
      // The detail endpoint fails until the retry asks for it again.
      let detailShouldFail = true
      await page.route('**/api/**', async route => {
        const request = route.request()
        const path = new URL(request.url()).pathname
        if (request.method() !== 'GET') {
          await route.continue()
          return
        }
        let json: unknown
        if (path === '/api/emails') {
          json = { emails: [{ id: 'error-mailbox', address, createdAt: Date.now(), expiresAt: Date.now() + 86_400_000, totalMessages: 1, unreadMessages: 0 }], total: 1, nextCursor: null }
        } else if (path === '/api/emails/error-mailbox') {
          json = { messages: [{ id: 'error-message', subject, from_address: 'sender@example.invalid', received_at: Date.now(), is_read: true }], total: 1, unread: 0, nextCursor: null, latestCursor: '1' }
        } else if (path === '/api/emails/error-mailbox/error-message') {
          if (detailShouldFail) {
            await route.fulfill({ status: 500, json: {} })
            return
          }
          json = {
            message: {
              id: 'error-message',
              subject,
              content: 'Recovered message body',
              from_address: 'sender@example.invalid',
              received_at: Date.now(),
              is_read: true,
            },
            total: 1,
            unread: 0,
          }
        } else {
          await route.continue()
          return
        }
        await route.fulfill({ json })
      })
      await page.goto(`/${locale}/mailbox`)
      // The mailbox pane renders from the client session.
      await expectClientReady(page, locale, scriptErrors)
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`))
      const mailboxRow = page.locator('.fluent-list-item').filter({ hasText: address })
      await mailboxRow.getByRole('button').filter({ hasText: address }).click()
      const messageRow = page.locator('.fluent-list-item').filter({ has: page.getByText(subject, { exact: true }) })
      await expect(messageRow).toBeVisible()
      await messageRow.getByRole('button').filter({ hasText: subject }).click()

      const emptyState = page.locator('.fluent-empty-state')
      await expect(emptyState).toHaveCount(1)
      await expect(emptyState).toBeVisible()
      await expect(emptyState).toHaveAttribute('role', 'alert')
      await expect(emptyState).toContainText(copy.network)
      await expect(emptyState.locator('.fluent-mark svg')).toHaveCount(1)
      await expect(emptyState.locator('.fluent-mark svg')).toHaveClass(/text-destructive/)
      const retry = emptyState.getByRole('button', { name: copy.retry, exact: true })
      await expect(retry).toBeVisible()
      await expect(retry).toHaveClass(/fluent-button/)
      await expect(retry).toHaveClass(/h-9/)
      await expect(retry).not.toHaveClass(/text-xs/)
      await page.screenshot({ path: testInfo.outputPath(`${locale}-${theme}-message-error.png`), animations: 'disabled' })

      // The retry control refetches the message in place; the application keeps
      // its state and is not reloaded.
      let reloads = 0
      const countReload = () => { reloads += 1 }
      page.on('load', countReload)
      detailShouldFail = false
      await retry.click()
      await expect(page.getByText('Recovered message body')).toBeVisible()
      await expect(emptyState).toHaveCount(0)
      expect(reloads).toBe(0)
      page.off('load', countReload)
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`))
    })
  }
}
