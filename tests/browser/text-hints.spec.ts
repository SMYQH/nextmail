import { expect, test, type Locator } from '@playwright/test'
import { MAILBOX_COPY, collectScriptErrors, expectClientReady, readSession, registerThroughUi } from './support'

// Public-page setup uses a real local mailbox and share; displayed message/admin rows are fixtures.
test.use({ serviceWorkers: 'block' })

const LONG_SUBJECT = 'Long subject <>&" '.repeat(12)
const LONG_SENDER = `${'a'.repeat(90)}@sender.example.invalid`
const LONG_ADMIN_NAME = 'Long display name — '.repeat(8)
const LONG_ADMIN_EMAIL = `${'m'.repeat(60)}@members.example.invalid`
const LONG_DOMAIN = 'very-long-service-domain.example.invalid'

for (const locale of ['en', 'zh-CN'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${locale} truncated values retain full hints in ${theme}`, async ({ page }, testInfo) => {
      await page.addInitScript(value => localStorage.setItem('temp-mail-theme', value), theme)
      const scriptErrors = collectScriptErrors(page)
  const username = await registerThroughUi(page, locale, scriptErrors)
      const session = await readSession(page)
      const prefix = `mailbox-${username}`.slice(0, 20)
      const response = await page.request.post('/api/emails/generate', { data: { name: prefix, domain: 'test.example.com', expiryTime: 86_400_000 } })
      expect(response.ok()).toBe(true)
      const mailbox = await response.json() as { id: string; email: string }
      expect(mailbox.email).toBe(`${prefix}@test.example.com`)
      try {
        const shared = await page.request.post(`/api/emails/${mailbox.id}/share`, { data: { expiresIn: 86_400_000 } })
        expect(shared.status()).toBe(201)
        const { token } = await shared.json() as { token: string }
        const created = Date.UTC(2030, 0, 2, 15, 4, 5)
        const message = { id: 'hint-message', subject: LONG_SUBJECT, from_address: LONG_SENDER, received_at: created, is_read: true }
        let publicRefreshes = 0
        await page.route('**/api/**', async route => {
          const request = route.request()
          expect(request.method(), 'display checks must not write server configuration').toBe('GET')
          const path = new URL(request.url()).pathname
          let json: unknown
          if (path === '/api/auth/session') {
            json = { ...session, user: { ...session.user, roles: [{ name: 'emperor' }] } }
          } else if (path === '/api/emails') {
            json = { emails: [{ id: mailbox.id, address: mailbox.email, createdAt: created, expiresAt: created + 86_400_000, totalMessages: 1, unreadMessages: 0 }], total: 1, nextCursor: null }
          } else if (path === `/api/emails/${mailbox.id}`) {
            json = { messages: [message], total: 1, unread: 0, nextCursor: null, latestCursor: String(created) }
          } else if (path === `/api/emails/${mailbox.id}/messages/hint-message/share`) {
            json = { shares: [] }
          } else if (path === '/api/api-keys') {
            json = { apiKeys: [] }
          } else if (path === '/api/webhook') {
            json = { enabled: false, url: '' }
          } else if (path === '/api/roles/users') {
            json = { users: [{ id: 'hint-user', name: LONG_ADMIN_NAME, username: 'hint_user', email: LONG_ADMIN_EMAIL, image: null, role: 'knight', allowedDomains: null }], total: 1, page: 1, pageSize: 10 }
          } else if (path === '/api/config/email-service') {
            json = { domains: { [LONG_DOMAIN]: { enabled: false, apiKey: '', hasApiKey: false, configured: true } }, roleLimits: { duke: -1, knight: -1 } }
          } else if (path === `/api/shared/${token}/messages`) {
            publicRefreshes++
            json = { messages: [message], total: 1, nextCursor: null }
          } else {
            await route.continue()
            return
          }
          await route.fulfill({ json })
        })
        const measurements: string[] = []
        async function checkHint(element: Locator, fullValue: string, expectClipped = false) {
          await expect(element).toBeVisible()
          await expect(element).toHaveAttribute('title', fullValue)
          await expect(element).toHaveCSS('text-overflow', 'ellipsis')
          await expect(element).toHaveCSS('white-space', 'nowrap')
          await element.scrollIntoViewIfNeeded()
          const before = await element.boundingBox()
          expect(before).not.toBeNull()
          await element.hover()
          const after = await element.boundingBox()
          expect(after).not.toBeNull()
          expect(Math.abs(after!.width - before!.width)).toBeLessThan(0.5)
          expect(Math.abs(after!.height - before!.height)).toBeLessThan(0.5)
          const geometry = await element.evaluate(node => ({
            client: node.clientWidth, scroll: node.scrollWidth,
            tag: node.tagName, display: getComputedStyle(node).display,
          }))
          const label = `${geometry.tag} ${fullValue.slice(0, 24)}`
          measurements.push(`${label} client=${geometry.client} scroll=${geometry.scroll} display=${geometry.display}`)
          if (expectClipped) {
            expect(
              geometry.scroll > geometry.client,
              `${label} should be visually truncated: ${measurements.join(' | ')}`,
            ).toBe(true)
          }
        }
        await page.goto(`/${locale}/mailbox`)
    // The mailbox pane renders from the client session.
    await expectClientReady(page, locale, scriptErrors)
        await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`))
        const mailboxRow = page.locator('.fluent-list-item').filter({ hasText: mailbox.email })
        await checkHint(mailboxRow.getByTitle(mailbox.email, { exact: true }), mailbox.email)
        await page.getByRole('button', { name: MAILBOX_COPY[locale].createEmail, exact: true }).click()
        const dialog = page.getByRole('dialog')
        await dialog.getByPlaceholder(MAILBOX_COPY[locale].namePlaceholder, { exact: true }).fill(prefix)
        await checkHint(dialog.getByTitle(mailbox.email, { exact: true }), mailbox.email)
        await page.keyboard.press('Escape')
        await expect(dialog).toBeHidden()
        const selectMailbox = mailboxRow.getByRole('button').filter({ hasText: mailbox.email })
        await selectMailbox.focus()
        await page.keyboard.press('Enter')
        await checkHint(page.getByTitle(mailbox.email, { exact: true }).first(), mailbox.email)
        const messageRow = page.locator('.fluent-list-item').filter({ has: page.getByText(LONG_SUBJECT, { exact: true }) })
        await checkHint(messageRow.getByTitle(LONG_SUBJECT, { exact: true }), LONG_SUBJECT, true)
        await checkHint(messageRow.getByTitle(LONG_SENDER, { exact: true }), LONG_SENDER, true)
        await page.screenshot({ path: testInfo.outputPath(`${locale}-${theme}-private-hints.png`), animations: 'disabled' })
        await messageRow.getByRole('button', { name: locale === 'en' ? 'Share' : '分享', exact: true }).click()
        await checkHint(dialog.getByTitle(LONG_SUBJECT, { exact: true }), LONG_SUBJECT, true)
        await page.keyboard.press('Escape')
        await expect(dialog).toBeHidden()

        await page.goto(`/${locale}/profile`)
    // The profile panes render from the client session.
    await expectClientReady(page, locale, scriptErrors)
        await checkHint(page.getByRole('heading', { name: username, exact: true }), username)
        await checkHint(page.locator(`[title="${username}"]`).first(), username)
        await checkHint(page.getByTitle(LONG_ADMIN_NAME, { exact: true }), LONG_ADMIN_NAME, true)
        await checkHint(page.getByTitle(LONG_ADMIN_EMAIL, { exact: true }), LONG_ADMIN_EMAIL, true)
        await checkHint(page.getByTitle(LONG_DOMAIN, { exact: true }), LONG_DOMAIN)
        await page.screenshot({ path: testInfo.outputPath(`${locale}-${theme}-profile-hints.png`), animations: 'disabled' })

        await page.goto(`/${locale}/shared/${token}`)
        // Exercise the refresh without depending on unrelated accessible-name changes.
        await page.locator('button:visible').filter({ has: page.locator('svg.lucide-refresh-cw') }).click()
        await expect.poll(() => publicRefreshes).toBeGreaterThan(0)
        await checkHint(page.locator('[title]:visible').filter({ hasText: LONG_SUBJECT }).first(), LONG_SUBJECT, true)
        await checkHint(page.locator('[title]:visible').filter({ hasText: LONG_SENDER }).first(), LONG_SENDER, true)
        await page.screenshot({ path: testInfo.outputPath(`${locale}-${theme}-public-hints.png`), animations: 'disabled', fullPage: true })
      } finally {
        // Delete only this test's own mailbox; its local share is removed by the cascade.
        const cleanup = await page.request.delete(`/api/emails/${mailbox.id}`)
        expect(cleanup.ok()).toBe(true)
      }
    })
  }
}
