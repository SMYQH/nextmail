import { expect, test } from '@playwright/test'
import { collectScriptErrors, expectClientReady, readSession, registerThroughUi } from './support'

test.use({ serviceWorkers: 'block' })

for (const locale of ['en', 'zh-CN'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${locale} supports accessible bulk mailbox deletion in ${theme}`, async ({ page }, testInfo) => {
      await page.addInitScript(value => localStorage.setItem('temp-mail-theme', value), theme)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      const scriptErrors = collectScriptErrors(page)
      await registerThroughUi(page, locale, scriptErrors)
      const session = await readSession(page)
      const copy = locale === 'en' ? {
        selectFirst: 'Select one@example.com for deletion',
        selectSecond: 'Select two@example.com for deletion',
        selectCatchAll: 'Select all@example.com for deletion',
        selected: '2 selected',
        deleteSelected: 'Delete selected (2)',
        deleting: 'Deleting…',
        cancel: 'Cancel',
        error: 'One or more selected mailboxes are unavailable or cannot be deleted. No mailboxes were removed; refresh and try again.',
        success: '2 mailboxes deleted successfully',
      } : {
        selectFirst: '选择要删除的邮箱：one@example.com',
        selectSecond: '选择要删除的邮箱：two@example.com',
        selectCatchAll: '选择要删除的邮箱：all@example.com',
        selected: '已选择 2 个',
        deleteSelected: '删除所选（2）',
        deleting: '正在删除…',
        cancel: '取消',
        error: '一个或多个所选邮箱已不可用或无法删除。没有邮箱被删除，请刷新后重试。',
        success: '已成功删除 2 个邮箱',
      }
      const now = Date.now()
      const emails = [
        { id: 'bulk-one', address: 'one@example.com', createdAt: now, expiresAt: now + 86_400_000, isCatchAll: false, totalMessages: 1, unreadMessages: 1 },
        { id: 'bulk-two', address: 'two@example.com', createdAt: now - 1, expiresAt: now + 86_400_000, isCatchAll: false, totalMessages: 0, unreadMessages: 0 },
        { id: 'bulk-catch-all', address: 'all@example.com', createdAt: now - 2, expiresAt: now + 86_400_000, isCatchAll: true, totalMessages: 0, unreadMessages: 0 },
      ]
      let bulkAttempts = 0
      let receivedIds: string[] = []
      let releaseSuccess!: () => void
      let markSecondRequest!: () => void
      const successGate = new Promise<void>(resolve => { releaseSuccess = resolve })
      const secondRequest = new Promise<void>(resolve => { markSecondRequest = resolve })

      await page.route('**/api/**', async route => {
        const request = route.request()
        const path = new URL(request.url()).pathname
        if (path === '/api/emails/bulk' && request.method() === 'DELETE') {
          bulkAttempts += 1
          const body = request.postDataJSON() as { ids: string[] }
          receivedIds = body.ids
          if (bulkAttempts === 1) {
            await route.fulfill({ status: 403, json: { error: 'unavailable' } })
            return
          }
          markSecondRequest()
          await successGate
          await route.fulfill({ json: { success: true, deletedIds: body.ids } })
          return
        }
        if (request.method() === 'GET' && path === '/api/auth/session') {
          await route.fulfill({ json: { ...session, user: { ...session.user, roles: [{ name: 'emperor' }] } } })
        } else if (request.method() === 'GET' && path === '/api/emails') {
          await route.fulfill({ json: { emails, nextCursor: null, total: emails.length } })
        } else if (request.method() === 'GET' && path === '/api/config') {
          await route.fulfill({ json: { emailDomains: 'example.com', availableEmailDomains: ['example.com'], maxEmails: 30 } })
        } else {
          await route.continue()
        }
      })

      await page.goto(`/${locale}/mailbox`)
      await expectClientReady(page, locale, scriptErrors)
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`))

      const firstCheckbox = page.getByRole('checkbox', { name: copy.selectFirst, exact: true })
      const secondCheckbox = page.getByRole('checkbox', { name: copy.selectSecond, exact: true })
      const firstCheckboxInput = page.locator('#mailbox-select-bulk-one')
      await expect(page.getByRole('checkbox', { name: copy.selectCatchAll, exact: true })).toHaveCount(0)
      await firstCheckbox.focus()
      await page.keyboard.press('Space')
      await expect(firstCheckbox).toBeChecked()
      await secondCheckbox.check()
      await expect(page.getByRole('status')).toContainText(copy.selected)

      await page.getByRole('button', { name: copy.deleteSelected, exact: true }).click()
      const dialog = page.getByRole('alertdialog')
      await expect(dialog).toBeVisible()
      await expect(dialog).toContainText(locale === 'en'
        ? 'Delete 2 selected mailboxes and all their messages and sharing links? This cannot be undone.'
        : '确定删除所选的 2 个邮箱及其中所有邮件和分享链接吗？此操作无法撤销。')

      const confirm = dialog.getByRole('button', { name: copy.deleteSelected, exact: true })
      await confirm.click()
      await expect(page.getByText(copy.error, { exact: true })).toBeVisible()
      await expect(dialog).toBeVisible()
      await dialog.getByRole('button', { name: copy.cancel, exact: true }).click()
      await expect(dialog).toBeHidden()
      await expect(firstCheckbox).toBeChecked()
      await expect(secondCheckbox).toBeChecked()
      await page.screenshot({ path: testInfo.outputPath(`${locale}-${theme}-bulk-delete-error.png`), animations: 'disabled' })

      await page.getByRole('button', { name: copy.deleteSelected, exact: true }).click()
      await expect(dialog).toBeVisible()
      const retry = dialog.getByRole('button', { name: copy.deleteSelected, exact: true })
      await retry.focus()
      const pendingClick = retry.press('Enter')
      await secondRequest
      await expect(dialog.getByRole('button', { name: copy.deleting, exact: true })).toBeDisabled()
      await expect(dialog.getByRole('button', { name: copy.cancel, exact: true })).toBeDisabled()
      await expect(firstCheckboxInput).toBeDisabled()
      expect(receivedIds).toEqual(['bulk-one', 'bulk-two'])

      releaseSuccess()
      await pendingClick
      await expect(dialog).toBeHidden()
      await expect(page.getByText(copy.success, { exact: true })).toBeVisible()
      await expect(page.getByText('one@example.com', { exact: true })).toHaveCount(0)
      await expect(page.getByText('two@example.com', { exact: true })).toHaveCount(0)
      await expect(page.getByText('all@example.com', { exact: true })).toBeVisible()
      expect(bulkAttempts).toBe(2)
      expect(scriptErrors).toEqual([])
      await page.screenshot({ path: testInfo.outputPath(`${locale}-${theme}-bulk-delete-success.png`), animations: 'disabled' })
    })
  }
}
