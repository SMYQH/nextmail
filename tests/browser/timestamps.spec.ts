import { expect, test } from '@playwright/test'
import { collectScriptErrors, expectProfileReady, registerThroughUi, type Locale } from './support'

// Keep the browser English: Chinese app formatting must not inherit this locale.
test.use({ locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block' })

const created = Date.UTC(2030, 0, 2, 15, 4, 5)
const expires = Date.UTC(2030, 0, 3, 16, 5, 6)
const address = 'date-fixture@test.example.com'
const subject = 'Date fixture subject'
const message = {
  id: 'date-message', subject, from_address: 'sender@example.invalid',
  received_at: created, sent_at: created, content: 'Date fixture content', is_read: true,
}
const shares = [{
  id: 'date-share', token: 'synthetic-date-share', createdAt: created, expiresAt: expires, enabled: true,
}, {
  id: 'permanent-share', token: 'synthetic-permanent-share', createdAt: created, expiresAt: null, enabled: true,
}]

for (const locale of ['en', 'zh-CN'] as const satisfies readonly Locale[]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${locale} timestamps follow the app locale in ${theme} theme`, async ({ page }, testInfo) => {
      await page.addInitScript(value => localStorage.setItem('temp-mail-theme', value), theme)
      const scriptErrors = collectScriptErrors(page)
      await registerThroughUi(page, locale, scriptErrors)
      const hydrationErrors: string[] = []
      page.on('console', entry => {
        if (entry.type() === 'error' && /hydration|did not match|server rendered/i.test(entry.text())) {
          hydrationErrors.push(entry.text())
        }
      })
      const visited = new Set<string>()
      // Only date fixtures are mocked. Authentication still uses the real local app.
      await page.route('**/api/emails**', async route => {
        const path = new URL(route.request().url()).pathname
        let json: unknown
        if (path === '/api/emails') {
          json = { emails: [{
            id: 'date-mailbox', address, createdAt: created, expiresAt: expires,
            totalMessages: 3, unreadMessages: 0,
          }, {
            id: 'permanent-mailbox', address: 'permanent@test.example.com', createdAt: created,
            expiresAt: Date.UTC(9999, 11, 31), totalMessages: 0, unreadMessages: 0,
          }], total: 2, nextCursor: null }
        } else if (path === '/api/emails/date-mailbox') {
          json = { messages: [message, {
            ...message, id: 'undated-message', subject: 'Undated fixture subject', received_at: 0, sent_at: 0,
          }, {
            ...message, id: 'invalid-date-message', subject: 'Invalid date fixture subject', received_at: 'not-a-date', sent_at: 0,
          }], nextCursor: null, latestCursor: String(created), total: 3, unread: 0 }
        } else if (path === '/api/emails/date-mailbox/date-message') {
          json = { message, total: 3, unread: 0 }
        } else if (path === '/api/emails/date-mailbox/share' || path === '/api/emails/date-mailbox/messages/date-message/share') {
          json = { shares }
        } else {
          await route.continue()
          return
        }
        expect(route.request().method()).toBe('GET')
        visited.add(path)
        await route.fulfill({ json })
      })
      await page.route('**/api/api-keys', async route => {
        expect(route.request().method()).toBe('GET')
        visited.add('/api/api-keys')
        await route.fulfill({ json: { apiKeys: [{
          id: 'date-key', name: 'Date fixture key', createdAt: new Date(created).toISOString(),
          expiresAt: null, enabled: true,
        }] } })
      })
      const copy = locale === 'en'
        ? { share: 'Share', permanent: 'Permanent' }
        : { share: '分享', permanent: '永久' }
      const dateText = (value: number) => new Date(value).toLocaleString(locale, { timeZone: 'UTC' })
      const dateSelector = (value: number) => `time[datetime="${new Date(value).toISOString()}"]`
      await page.goto(`/${locale}/mailbox`)
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`))
      const mailboxRow = page.locator('.fluent-list-item').filter({ hasText: address })
      await expect(mailboxRow.locator(dateSelector(expires))).toHaveText(dateText(expires))
      const permanentRow = page.locator('.fluent-list-item').filter({ hasText: 'permanent@test.example.com' })
      await expect(permanentRow).toContainText(copy.permanent)
      await expect(permanentRow.locator('time')).toHaveCount(0)

      await mailboxRow.getByRole('button', { name: copy.share, exact: true }).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.locator(dateSelector(created)).first()).toHaveText(dateText(created))
      await expect(dialog.locator(dateSelector(expires))).toHaveText(dateText(expires))
      await expect(dialog).toContainText(copy.permanent)
      await expect(dialog).toHaveCSS('opacity', '1')
      await page.screenshot({ path: testInfo.outputPath(`${locale}-${theme}-share-dates.png`), animations: 'disabled', fullPage: true })
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()

      await mailboxRow.getByRole('button').filter({ hasText: address }).click()
      const messageRow = page.locator('.fluent-list-item').filter({ has: page.getByText(subject, { exact: true }) })
      await expect(messageRow.locator(dateSelector(created))).toHaveText(dateText(created))
      for (const undatedSubject of ['Undated fixture subject', 'Invalid date fixture subject']) {
        const undatedRow = page.locator('.fluent-list-item').filter({ has: page.getByText(undatedSubject, { exact: true }) })
        await expect(undatedRow).toBeVisible()
        await expect(undatedRow.locator('time')).toHaveCount(0)
        await expect(undatedRow).not.toContainText('1970')
      }
      await page.screenshot({ path: testInfo.outputPath(`${locale}-${theme}-missing-dates.png`), animations: 'disabled', fullPage: true })
      await messageRow.getByRole('button', { name: copy.share, exact: true }).click()
      await expect(dialog.locator(dateSelector(created)).first()).toHaveText(dateText(created))
      await expect(dialog.locator(dateSelector(expires))).toHaveText(dateText(expires))
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
      await messageRow.getByRole('button').filter({ hasText: subject }).click()
      await expect(page.getByText(message.content, { exact: true })).toBeVisible()
      await expect(page.locator('p').locator(dateSelector(created))).toHaveText(dateText(created))
      await page.screenshot({ path: testInfo.outputPath(`${locale}-${theme}-message-date.png`), animations: 'disabled', fullPage: true })

      await page.goto(`/${locale}/profile`)
      // The key list renders from the client session.
      await expectProfileReady(page, locale, scriptErrors)
      await expect(page.getByText('Date fixture key', { exact: true })).toBeVisible()
      await expect(page.locator(dateSelector(created))).toHaveText(dateText(created))
      await page.screenshot({ path: testInfo.outputPath(`${locale}-${theme}-key-date.png`), animations: 'disabled', fullPage: true })
      expect([...visited].sort()).toEqual([
        '/api/api-keys', '/api/emails', '/api/emails/date-mailbox',
        '/api/emails/date-mailbox/date-message', '/api/emails/date-mailbox/messages/date-message/share',
        '/api/emails/date-mailbox/share',
      ].sort())
      expect(hydrationErrors).toEqual([])
    })
  }
}
