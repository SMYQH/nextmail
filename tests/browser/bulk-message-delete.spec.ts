import { expect, test } from '@playwright/test'
import { COMMON_COPY, expectClientReady, readSession, registerThroughUi } from './support'

test.use({ serviceWorkers: 'block' })

for (const [locale, theme] of [['en', 'light'], ['zh-CN', 'dark']] as const) {
  test(`${locale} deletes selected inbox and sent messages in ${theme}`, async ({ page }, testInfo) => {
    await page.addInitScript(value => localStorage.setItem('temp-mail-theme', value), theme)
    await registerThroughUi(page, locale)
    const session = await readSession(page)
    const copy = locale === 'en' ? {
      select: (subject: string) => `Select ${subject} for deletion`,
      bulk: 'Delete selected', confirm: 'Delete', deleting: 'Deleting…', received: 'Received', sent: 'Sent',
      selected: '2 selected', empty: 'No messages yet',
      selectionChanged: 'Unavailable messages were removed from your selection. No messages were deleted.',
    } : {
      select: (subject: string) => `选择要删除的邮件：${subject}`,
      bulk: '删除所选', confirm: '删除', deleting: '正在删除…', received: '收件箱', sent: '已发送',
      selected: '已选择 2 封', empty: '暂无邮件',
      selectionChanged: '不可用的邮件已从选择中移除。未删除任何邮件。',
    }
    const address = 'bulk-messages@example.test'
    const now = Date.now()
    const folders = {
      received: ['Inbox first', 'Inbox vanished', 'Inbox survivor', 'Inbox older', 'Inbox earlier', 'Inbox oldest'],
      sent: ['Sent first', 'Sent second'],
    }
    const requests: Array<{ ids: string[]; type: string }> = []
    let releaseDelete!: () => void
    const pendingDelete = new Promise<void>(resolve => { releaseDelete = resolve })

    await page.route('**/api/**', async route => {
      const request = route.request()
      const url = new URL(request.url())
      const type = url.searchParams.get('type') === 'sent' ? 'sent' : 'received'
      const subjects = folders[type]
      const inboxCount = folders.received.length
      const mailboxPath = '/api/emails/bulk-messages'
      if (url.pathname === '/api/auth/session') {
        await route.fulfill({ json: session })
      } else if (url.pathname === '/api/emails/send-permission') {
        await route.fulfill({ json: { canSend: true, enabledDomains: ['example.test'] } })
      } else if (url.pathname === '/api/emails') {
        await route.fulfill({ json: { emails: [{
          id: 'bulk-messages', address, createdAt: now, expiresAt: now + 86_400_000,
          totalMessages: inboxCount, unreadMessages: inboxCount,
        }], total: 1, nextCursor: null } })
      } else if (url.pathname === mailboxPath) {
        const offset = Number(url.searchParams.get('cursor') ?? 0)
        const pageEnd = offset + 2
        const messages = subjects.map((subject, index) => ({
          id: subject, subject, from_address: 'sender@example.test', to_address: address,
          received_at: now - index * 1000, sent_at: now - index * 1000, is_read: false,
        }))
        await route.fulfill({ json: {
          messages: url.searchParams.has('since') ? [] : messages.slice(offset, pageEnd),
          total: messages.length, unread: messages.length, latestCursor: '3',
          nextCursor: pageEnd < messages.length ? String(pageEnd) : null,
        } })
      } else if (request.method() === 'DELETE' && url.pathname === `${mailboxPath}/messages/bulk`) {
        const { ids } = request.postDataJSON() as { ids: string[] }
        requests.push({ ids, type })
        if (requests.length === 1) {
          await route.fulfill({ status: 403, json: { error: 'unavailable' } })
          return
        }
        if (requests.length === 2) {
          await pendingDelete
          folders.received = subjects.filter(subject => subject !== 'Inbox vanished')
          await route.fulfill({ status: 403, json: { unavailableIds: ['Inbox vanished'] } })
          return
        }
        folders[type] = subjects.filter(subject => !ids.includes(subject))
        await route.fulfill({ json: {
          success: true, deletedIds: ids, total: folders[type].length, unread: folders[type].length,
        } })
      } else {
        await route.continue()
      }
    })

    await page.goto(`/${locale}/mailbox`)
    await expectClientReady(page, locale)
    const mailbox = page.locator('.fluent-list-item').filter({ hasText: address })
    await expect(mailbox.getByRole('checkbox')).toHaveCSS('width', '32px')
    await expect(mailbox.getByRole('checkbox').locator('xpath=following-sibling::span')).toHaveCSS('width', '16px')
    await mailbox.getByRole('button').filter({ hasText: address }).click()
    await expect(page.getByRole('tab', { name: copy.sent, exact: true })).toBeVisible()

    const pane = page.getByRole('tabpanel')
    const checkbox = (subject: string) => pane.getByRole('checkbox', { name: copy.select(subject), exact: true })
    const first = checkbox('Inbox first')
    await first.focus()
    await first.press('Space')
    await expect(first).toBeChecked()
    const older = checkbox('Inbox older')
    await expect.poll(async () => {
      await pane.locator('.overflow-auto').dispatchEvent('scroll')
      return older.count()
    }).toBe(1)
    await older.check()
    await expect(pane.getByRole('status')).toHaveText(copy.selected)
    await page.screenshot({ path: testInfo.outputPath(`${locale}-${theme}-messages-selected.png`), animations: 'disabled' })

    const dialog = page.getByRole('alertdialog')
    const confirm = dialog.getByRole('button', { name: copy.confirm, exact: true })
    await pane.getByRole('button', { name: copy.bulk, exact: true }).click()
    await confirm.press('Enter')
    await expect(dialog.getByRole('alert')).toHaveText(locale === 'en'
      ? 'One or more selected messages are unavailable or cannot be deleted. No messages were deleted.'
      : '一封或多封所选邮件已不可用或无法删除。未删除任何邮件。')
    await expect(dialog).toBeVisible()
    await expect(confirm).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(first).toBeChecked()
    await expect(checkbox('Inbox older')).toBeChecked()

    const vanished = checkbox('Inbox vanished')
    await vanished.check()
    const bulkDelete = pane.getByRole('button', { name: copy.bulk, exact: true })
    await bulkDelete.click()
    await confirm.press('Enter')
    try {
      const pending = dialog.getByRole('button', { name: copy.deleting })
      await expect(pending).toBeDisabled()
      await expect(pending).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(pending).toBeFocused()
      await page.keyboard.press('Enter')
      await expect.poll(() => requests).toEqual([
        { ids: ['Inbox first', 'Inbox older'], type: 'received' },
        { ids: ['Inbox first', 'Inbox older', 'Inbox vanished'], type: 'received' },
      ])
    } finally {
      releaseDelete()
    }
    await expect(dialog).toBeHidden()
    await expect(vanished).toHaveCount(0)
    await expect(pane.getByRole('status')).toHaveText(copy.selected)
    await expect(page.getByText(copy.selectionChanged, { exact: true })).toBeVisible()
    await expect(bulkDelete).toBeFocused()
    await bulkDelete.press('Enter')
    await confirm.press('Enter')
    await expect(dialog).toBeHidden()
    await expect(first).toHaveCount(0)
    await expect(checkbox('Inbox older')).toHaveCount(0)
    await expect(pane.getByRole('button', { name: /Inbox survivor/ })).toBeFocused()
    expect(requests.at(-1)).toEqual({ ids: ['Inbox first', 'Inbox older'], type: 'received' })
    if (testInfo.project.name === 'desktop-chromium') await expect(mailbox.getByText('3 / 3')).toBeVisible()

    await page.getByRole('tab', { name: copy.sent, exact: true }).click()
    await expect(pane.getByRole('button', { name: copy.bulk, exact: true })).toHaveCount(0)
    await checkbox('Sent first').check()
    await checkbox('Sent second').check()
    await pane.getByRole('button', { name: copy.bulk, exact: true }).click()
    await confirm.click()
    await expect(pane.getByRole('status')).toHaveText(copy.empty)
    await expect(pane.getByRole('button', { name: COMMON_COPY[locale].refresh, exact: true })).toBeFocused()
    expect(requests.at(-1)).toEqual({ ids: ['Sent first', 'Sent second'], type: 'sent' })
    if (testInfo.project.name === 'desktop-chromium') await expect(mailbox.getByText('3 / 3')).toBeVisible()

    await page.getByRole('tab', { name: copy.received, exact: true }).click()
    await checkbox('Inbox survivor').check()
    await checkbox('Inbox earlier').check()
    await expect(checkbox('Inbox oldest')).toHaveCount(0)
    await pane.getByRole('button', { name: copy.bulk, exact: true }).click()
    await confirm.click()
    await expect(checkbox('Inbox oldest')).toBeVisible()
    expect(requests.at(-1)).toEqual({ ids: ['Inbox survivor', 'Inbox earlier'], type: 'received' })
    if (testInfo.project.name === 'desktop-chromium') await expect(mailbox.getByText('1 / 1')).toBeVisible()
  })
}
