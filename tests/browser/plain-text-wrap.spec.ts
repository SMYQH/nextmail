import { expect, test } from '@playwright/test'
import { collectScriptErrors, expectClientReady, registerThroughUi } from './support'

test.use({ serviceWorkers: 'block' })

const LONG_TOKEN = 'x'.repeat(600)
const SUBJECT = 'Plain text overflow fixture'

for (const locale of ['en', 'zh-CN'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${locale} plain-text bodies wrap long tokens in ${theme}`, async ({ page }, testInfo) => {
      await page.addInitScript(value => localStorage.setItem('temp-mail-theme', value), theme)
      const scriptErrors = collectScriptErrors(page)
      await registerThroughUi(page, locale, scriptErrors)
      const address = 'overflow@test.example.com'
      const content = `prefix ${LONG_TOKEN} suffix`
      await page.route('**/api/**', async route => {
        const request = route.request()
        const path = new URL(request.url()).pathname
        if (request.method() !== 'GET') {
          await route.continue()
          return
        }
        let json: unknown
        if (path === '/api/emails') {
          json = { emails: [{ id: 'overflow-mailbox', address, createdAt: Date.now(), expiresAt: Date.now() + 86_400_000, totalMessages: 1, unreadMessages: 0 }], total: 1, nextCursor: null }
        } else if (path === '/api/emails/overflow-mailbox') {
          json = { messages: [{ id: 'overflow-message', subject: SUBJECT, from_address: 'sender@example.invalid', received_at: Date.now(), is_read: true }], total: 1, unread: 0, nextCursor: null, latestCursor: '1' }
        } else if (path === '/api/emails/overflow-mailbox/overflow-message') {
          json = { message: { id: 'overflow-message', subject: SUBJECT, from_address: 'sender@example.invalid', received_at: Date.now(), content, html: null }, total: 1, unread: 0 }
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
      const messageRow = page.locator('.fluent-list-item').filter({ has: page.getByText(SUBJECT, { exact: true }) })
      await expect(messageRow).toBeVisible()
      await messageRow.getByRole('button').filter({ hasText: SUBJECT }).click()

      const body = page.locator('.whitespace-pre-wrap').last()
      await expect(body).toBeVisible()
      await expect(body).toContainText(LONG_TOKEN.slice(0, 40))
      await expect(body).toHaveCSS('overflow-wrap', 'anywhere')
      const overflow = await body.evaluate(node => ({
        scrollWidth: node.scrollWidth, clientWidth: node.clientWidth,
        paneScroll: node.parentElement?.scrollWidth ?? 0, paneClient: node.parentElement?.clientWidth ?? 0,
      }))
      expect(overflow.scrollWidth, 'the body must not overflow its own box').toBeLessThanOrEqual(overflow.clientWidth + 1)
      expect(overflow.paneScroll, 'the pane must not scroll horizontally').toBeLessThanOrEqual(overflow.paneClient + 1)
      const pageOverflow = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth,
      }))
      expect(pageOverflow.scroll, 'the document must not scroll horizontally').toBeLessThanOrEqual(pageOverflow.client + 1)
      await page.screenshot({ path: testInfo.outputPath(`${locale}-${theme}-plain-text.png`), animations: 'disabled', fullPage: true })
    })
  }
}
