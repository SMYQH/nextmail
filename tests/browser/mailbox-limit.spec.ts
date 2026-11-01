import { expect, test } from '@playwright/test'
import { collectScriptErrors, expectProfileReady, readSession, registerThroughUi } from './support'

test.use({ serviceWorkers: 'block' })

for (const locale of ['en', 'zh-CN'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${locale} mailbox limit matches the positive safe-integer rule in ${theme}`, async ({ page }, testInfo) => {
      await page.addInitScript(value => localStorage.setItem('temp-mail-theme', value), theme)
      const scriptErrors = collectScriptErrors(page)
      await registerThroughUi(page, locale, scriptErrors)
      const session = await readSession(page)
      let currentLimit = '30'
      const savedLimits: string[] = []
      const writePaths: string[] = []
      const copy = locale === 'en'
        ? {
            website: 'Website Configuration',
            save: 'Save Configuration',
            invalid: 'Enter a positive whole number within the safe integer range.',
          }
        : {
            website: '网站配置',
            save: '保存配置',
            invalid: '请输入安全整数范围内的正整数。',
          }

      await page.route('**/api/**', async route => {
        const request = route.request()
        const path = new URL(request.url()).pathname
        if (path === '/api/config' && request.method() === 'POST') {
          writePaths.push(path)
          const body = request.postDataJSON() as { maxEmails: string }
          savedLimits.push(body.maxEmails)
          currentLimit = body.maxEmails
          await route.fulfill({ json: { success: true } })
          return
        }
        if (request.method() !== 'GET') {
          writePaths.push(path)
          await route.fulfill({ status: 500, json: { error: 'unexpected_write' } })
          return
        }

        let json: unknown
        if (path === '/api/auth/session') {
          json = { ...session, user: { ...session.user, roles: [{ name: 'emperor' }] } }
        } else if (path === '/api/config') {
          json = {
            defaultRole: 'duke',
            emailDomains: 'test.example.com',
            availableEmailDomains: ['test.example.com'],
            adminContact: '',
            maxEmails: currentLimit,
            turnstile: { enabled: false, siteKey: '', hasSecret: false },
            catchAll: { domains: { 'test.example.com': { enabled: false, showAlways: true, mailboxName: '' } } },
          }
        } else if (path === '/api/api-keys') {
          json = { apiKeys: [] }
        } else if (path === '/api/webhook') {
          json = { enabled: false, url: '' }
        } else if (path === '/api/roles/users') {
          json = { users: [], total: 0, page: 1, pageSize: 10 }
        } else if (path === '/api/config/email-service') {
          json = { domains: {}, roleLimits: { duke: 5, knight: 2 } }
        } else {
          await route.continue()
          return
        }
        await route.fulfill({ json })
      })

      await page.goto(`/${locale}/profile`)
      await expectProfileReady(page, locale, scriptErrors)
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`))
      const panel = page.locator('.fluent-panel').filter({ hasText: copy.website }).first()
      await expect(panel).toBeVisible()
      const limitInput = panel.locator('input[type="number"]')
      const saveButton = panel.getByRole('button', { name: copy.save, exact: true })
      await expect(limitInput).toHaveAttribute('min', '1')
      await expect(limitInput).toHaveAttribute('max', String(Number.MAX_SAFE_INTEGER))
      await expect(limitInput).toHaveAttribute('step', '1')
      await expect(limitInput).toHaveValue('30')

      await limitInput.fill('-5')
      await saveButton.focus()
      await page.keyboard.press('Enter')
      await expect(page.getByText(copy.invalid, { exact: true })).toBeVisible()
      expect(writePaths, 'invalid input must not call any write endpoint').toEqual([])
      await limitInput.scrollIntoViewIfNeeded()
      await page.screenshot({ path: testInfo.outputPath(`${locale}-${theme}-invalid-mailbox-limit.png`), animations: 'disabled' })

      await limitInput.fill('1.0000000000000001')
      await saveButton.focus()
      await page.keyboard.press('Enter')
      await expect(page.getByText(copy.invalid, { exact: true }).first()).toBeVisible()
      expect(writePaths, 'fractional strings must not be rounded into an allowed limit').toEqual([])

      const boundaries = ['1', String(Number.MAX_SAFE_INTEGER)]
      for (const boundary of boundaries) {
        await limitInput.fill(boundary)
        await saveButton.focus()
        await page.keyboard.press('Enter')
        await expect.poll(() => savedLimits.length).toBe(boundaries.indexOf(boundary) + 1)
        await expect(saveButton).toBeEnabled()
        await expect(limitInput).toHaveValue(boundary)
      }
      expect(savedLimits).toEqual(boundaries)
      expect(writePaths).toEqual(['/api/config', '/api/config'])
      await limitInput.scrollIntoViewIfNeeded()
      await page.screenshot({ path: testInfo.outputPath(`${locale}-${theme}-valid-mailbox-limit.png`), animations: 'disabled' })
    })
  }
}
