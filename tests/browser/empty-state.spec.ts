import { expect, test } from '@playwright/test'
import { collectScriptErrors, expectClientReady, expectProfileReady, readSession, registerThroughUi } from './support'

test.use({ serviceWorkers: 'block' })

for (const locale of ['en', 'zh-CN'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${locale} empty states share one treatment in ${theme}`, async ({ page }, testInfo) => {
      await page.addInitScript(value => localStorage.setItem('temp-mail-theme', value), theme)
      const scriptErrors = collectScriptErrors(page)
      await registerThroughUi(page, locale, scriptErrors)
      const session = await readSession(page)
      const copy = locale === 'en'
        ? { noEmails: 'No emails yet, create one!', noMessages: 'No messages yet', noKeys: 'No API keys yet' }
        : { noEmails: '还没有邮箱，创建一个吧！', noMessages: '暂无邮件', noKeys: '暂无 API Key' }
      await page.route('**/api/**', async route => {
        const request = route.request()
        const path = new URL(request.url()).pathname
        if (request.method() !== 'GET') {
          await route.continue()
          return
        }
        let json: unknown
        if (path === '/api/auth/session') {
          json = { ...session, user: { ...session.user, roles: [{ name: 'emperor' }] } }
        } else if (path === '/api/emails') {
          json = { emails: [], total: 0, nextCursor: null }
        } else if (path === '/api/api-keys') {
          json = { apiKeys: [] }
        } else if (path === '/api/webhook') {
          json = { enabled: false, url: '' }
        } else if (path === '/api/roles/users') {
          json = { users: [], total: 0, page: 1, pageSize: 10 }
        } else {
          await route.continue()
          return
        }
        await route.fulfill({ json })
      })

      // The mailbox pane and the message pane share the same empty-state block.
      await page.goto(`/${locale}/mailbox`)
      // The mailbox pane renders from the client session.
      await expectClientReady(page, locale, scriptErrors)
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`))
      const mailboxEmpty = page.locator('.fluent-pane').first().locator('.fluent-empty-state').first()
      await expect(mailboxEmpty).toBeVisible()
      await expect(mailboxEmpty.locator('p.max-w-52').first()).toHaveText(copy.noEmails)
      // Every empty area on the page uses the same shared block.
      const emptyStates = page.locator('.fluent-empty-state')
      const count = await emptyStates.count()
      expect(count).toBeGreaterThanOrEqual(1)
      for (let index = 0; index < count; index += 1) {
        await expect(emptyStates.nth(index).locator('p.max-w-52').first()).toBeVisible()
      }
      await page.screenshot({ path: testInfo.outputPath(`${locale}-${theme}-empty-mailbox.png`), animations: 'disabled' })

      // The API-key panel uses the same block with the same message.
      await page.goto(`/${locale}/profile`)
      // The API key panel renders from the client session.
      await expectProfileReady(page, locale, scriptErrors)
      const panel = page.locator('.fluent-panel').filter({ hasText: locale === 'en' ? 'API Key Management' : 'API Key 管理' }).first()
      const panelEmpty = panel.locator('.fluent-empty-state').first()
      await expect(panelEmpty).toBeVisible()
      await expect(panelEmpty.locator('p.max-w-52').first()).toHaveText(copy.noKeys)
      await expect(panelEmpty.locator('.fluent-mark')).toHaveCount(1)
      await expect(panelEmpty).toHaveClass(/fluent-empty-state/)
      await panelEmpty.screenshot({ path: testInfo.outputPath(`${locale}-${theme}-empty-keys.png`), animations: 'disabled' })
    })
  }
}
