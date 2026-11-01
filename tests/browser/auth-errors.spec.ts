import { expect, test, type Locator } from '@playwright/test'
import { AUTH_COPY, uniqueUsername } from './support'

test.use({ serviceWorkers: 'block' })

for (const locale of ['en', 'zh-CN'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${locale} auth errors describe their fields in ${theme}`, async ({ page }, testInfo) => {
      await page.addInitScript(value => localStorage.setItem('temp-mail-theme', value), theme)
      const copy = AUTH_COPY[locale]
      const errors = locale === 'en' ? {
        usernameRequired: 'Please enter username', passwordRequired: 'Please enter password',
        confirmRequired: 'Please confirm password', invalidUsername: 'Username cannot contain @ symbol',
        shortPassword: 'Password must be at least 8 characters', mismatch: 'Passwords do not match',
      } : {
        usernameRequired: '请输入用户名', passwordRequired: '请输入密码', confirmRequired: '请确认密码',
        invalidUsername: '用户名不能包含 @ 符号', shortPassword: '密码长度必须大于等于8位', mismatch: '两次输入的密码不一致',
      }
      let authWrites = 0
      page.on('request', request => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/auth/callback/credentials') authWrites++
      })
      await page.goto(`/${locale}/login`)
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`))
      const panel = page.getByRole('tabpanel')
      const username = panel.getByPlaceholder(copy.username, { exact: true })
      const password = panel.getByPlaceholder(copy.password, { exact: true })
      const confirm = panel.getByPlaceholder(copy.confirmPassword, { exact: true })

      async function expectError(field: Locator, message: string) {
        await expect(field).toHaveAttribute('aria-invalid', 'true')
        await expect(field).toHaveAccessibleDescription(message)
        const id = await field.getAttribute('aria-describedby')
        expect(id).toBeTruthy()
        const error = page.locator(`[id="${id}"]`)
        await expect(error).toHaveCount(1)
        await expect(error).toHaveAttribute('role', 'alert')
        await expect(error).toHaveText(message)
      }
      async function expectClear(field: Locator) {
        await expect(field).not.toHaveAttribute('aria-invalid', 'true')
        await expect(field).not.toHaveAttribute('aria-describedby', /.+/)
        await expect(field).toHaveAccessibleDescription('')
      }
      async function submit(label: string) {
        await panel.getByRole('button', { name: label, exact: true }).focus()
        await page.keyboard.press('Enter')
      }

      await submit(copy.loginButton)
      await expectError(username, errors.usernameRequired)
      await expectError(password, errors.passwordRequired)
      await page.screenshot({ path: testInfo.outputPath(`${locale}-${theme}-login-errors.png`), animations: 'disabled', fullPage: true })
      await username.fill(uniqueUsername())
      await expectClear(username)
      await expectClear(password)
      await expect(panel.getByRole('alert')).toHaveCount(0)

      await page.getByRole('tab', { name: copy.registerTab, exact: true }).click()
      await submit(copy.registerButton)
      await expectError(username, errors.usernameRequired)
      await expectError(password, errors.passwordRequired)
      await expectError(confirm, errors.confirmRequired)
      await username.fill('bad@name')
      await password.fill('short')
      await confirm.fill('different')
      await submit(copy.registerButton)
      await expectError(username, errors.invalidUsername)
      await expectError(password, errors.shortPassword)
      await expectError(confirm, errors.mismatch)
      await page.screenshot({ path: testInfo.outputPath(`${locale}-${theme}-register-errors.png`), animations: 'disabled', fullPage: true })
      const ids = await page.locator('[id]').evaluateAll(elements => elements.map(element => element.id))
      expect(new Set(ids).size).toBe(ids.length)

      await page.getByRole('tab', { name: copy.loginTab, exact: true }).click()
      await expectClear(username)
      await expectClear(password)
      await expect(panel.getByRole('alert')).toHaveCount(0)
      expect(authWrites, 'client-side validation must not submit credentials').toBe(0)
    })
  }
}
