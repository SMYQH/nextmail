import { expect, test } from '@playwright/test'
import { collectScriptErrors, expectClientReady, readSession, registerThroughUi } from './support'

test.use({ serviceWorkers: 'block' })

const COPY = {
  en: { delete: 'Delete', refresh: 'Refresh' },
  'zh-CN': { delete: '删除', refresh: '刷新' },
} as const

for (const locale of ['en', 'zh-CN'] as const) {
  test(`${locale} deleting a message keeps the keyboard focus in the list`, async ({ page }) => {
    const scriptErrors = collectScriptErrors(page)
    await registerThroughUi(page, locale, scriptErrors)
    const session = await readSession(page)
    const copy = COPY[locale]
    const address = 'focus-mailbox@example.test'
    const subjects = ['First focus subject', 'Second focus subject']
    const messages = subjects.map((subject, index) => ({
      id: `focus-message-${index}`,
      subject,
      from_address: 'sender@example.invalid',
      received_at: Date.now() - index * 1000,
      is_read: true,
    }))
    const deleted: string[] = []

    await page.route('**/api/**', async route => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      if (request.method() === 'GET' && path === '/api/auth/session') {
        await route.fulfill({ json: { ...session, user: { ...session.user, roles: [{ name: 'emperor' }] } } })
        return
      }
      if (request.method() === 'GET' && path === '/api/emails/send-permission') {
        // The tabs keep the message list inside a single panel.
        await route.fulfill({ json: { canSend: true, enabledDomains: ['example.test'] } })
        return
      }
      if (request.method() === 'GET' && path === '/api/emails') {
        await route.fulfill({ json: {
          emails: [{ id: 'focus-mailbox', address, createdAt: Date.now(), expiresAt: Date.UTC(9999, 11, 31), totalMessages: messages.length, unreadMessages: 0 }],
          total: 1,
          nextCursor: null,
        } })
        return
      }
      if (request.method() === 'GET' && path === '/api/emails/focus-mailbox') {
        await route.fulfill({ json: {
          messages: messages.filter(message => !deleted.includes(message.id)),
          total: 1,
          unread: 0,
          nextCursor: null,
          latestCursor: '2',
        } })
        return
      }
      if (request.method() === 'DELETE' && path.startsWith('/api/emails/focus-mailbox/')) {
        deleted.push(path.slice('/api/emails/focus-mailbox/'.length))
        await route.fulfill({ json: { total: 0, unread: 0 } })
        return
      }
      await route.continue()
    })

    await page.goto(`/${locale}/mailbox`)
    await expectClientReady(page, locale, scriptErrors)
    await page.locator('.fluent-list-item')
      .filter({ hasText: address })
      .getByRole('button')
      .filter({ hasText: address })
      .click()

    const deleteMessage = async (subject: string) => {
      const row = page.locator('.fluent-list-item').filter({ hasText: subject })
      await expect(row).toBeVisible()
      await row.getByRole('button', { name: copy.delete, exact: true }).click()
      const dialog = page.getByRole('alertdialog')
      await expect(dialog).toBeVisible()
      await dialog.getByRole('button', { name: copy.delete, exact: true }).click()
      await expect(row).toHaveCount(0)
    }

    // The removed row takes the focused control with it, so the focus moves to
    // the row that takes its place.
    await deleteMessage(subjects[0])
    const remaining = page.locator('.fluent-list-item').filter({ hasText: subjects[1] })
    await expect(remaining).toBeVisible()
    await expect(remaining.getByRole('button').filter({ hasText: subjects[1] })).toBeFocused()

    // An empty list keeps the focus inside the list pane.
    await deleteMessage(subjects[1])
    const refresh = page.getByRole('tabpanel').getByRole('button', { name: copy.refresh, exact: true })
    await expect(refresh).toBeFocused()
  })
}
