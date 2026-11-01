import { expect, test, type Locator } from '@playwright/test'
import { collectScriptErrors, expectProfileReady, registerThroughUi } from './support'

test.use({ serviceWorkers: 'block' })

for (const locale of ['en', 'zh-CN'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${locale} owners can load older keys and share links in ${theme}`, async ({ page }, testInfo) => {
      await page.addInitScript(value => localStorage.setItem('temp-mail-theme', value), theme)
      const scriptErrors = collectScriptErrors(page)
      await registerThroughUi(page, locale, scriptErrors)
      const loadMoreName = locale === 'en' ? 'Load more' : '加载更多'
      const date = '2030-01-02T15:04:05.000Z'
      const key = (id: string) => ({ id, name: `Pagination key ${id}`, key: `mk_pagination_secret_${id}`, createdAt: date, expiresAt: null, enabled: true })
      const share = (id: string) => ({ id, token: `pagination-${id}`, createdAt: date, expiresAt: null })
      let keyPageAttempts = 0
      let releaseKeyPage: (() => void) | undefined
      const keyPageReady = new Promise<void>(resolve => { releaseKeyPage = resolve })
      const requestedCursors: string[] = []
      await page.route('**/api/**', async route => {
        const request = route.request()
        expect(request.method(), 'pagination checks do not mutate server data').toBe('GET')
        const url = new URL(request.url())
        let json: unknown
        if (url.pathname === '/api/api-keys') {
          if (url.searchParams.has('cursor')) {
            requestedCursors.push(url.searchParams.get('cursor')!)
            keyPageAttempts++
            if (keyPageAttempts === 1) {
              await keyPageReady
              await route.fulfill({ status: 503, json: { error: 'Synthetic page failure' } })
              return
            }
            json = { apiKeys: [key('first'), key('older')], nextCursor: null }
          } else json = { apiKeys: [key('first')], nextCursor: 'key cursor+/=' }
        } else if (url.pathname === '/api/emails') {
          json = { emails: [{ id: 'pagination-email', address: 'pagination@test.example.com', createdAt: date, expiresAt: '2031-01-01T00:00:00.000Z', totalMessages: 1, unreadMessages: 0 }], total: 1, nextCursor: null }
        } else if (url.pathname === '/api/emails/pagination-email') {
          json = { messages: [{ id: 'pagination-message', subject: 'Pagination message', from_address: 'sender@example.com', received_at: date, is_read: true }], total: 1, unread: 0, nextCursor: null, latestCursor: null }
        } else if (url.pathname === '/api/emails/pagination-email/share' || url.pathname === '/api/emails/pagination-email/messages/pagination-message/share') {
          const kind = url.pathname.includes('/messages/') ? 'message' : 'mailbox'
          if (url.searchParams.has('cursor')) {
            requestedCursors.push(url.searchParams.get('cursor')!)
            json = { shares: [share(`${kind}-first`), share(`${kind}-older`)], total: 2, nextCursor: null }
          } else json = { shares: [share(`${kind}-first`)], total: 2, nextCursor: `${kind} cursor+/=` }
        } else if (url.pathname === '/api/webhook') {
          json = { enabled: false, url: '' }
        } else {
          await route.continue()
          return
        }
        await route.fulfill({ json })
      })

      await page.goto(`/${locale}/profile`)
      // The key panel renders from the client session.
      await expectProfileReady(page, locale, scriptErrors)
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`))
      const keyPanel = page.locator('.fluent-panel').filter({ hasText: locale === 'en' ? 'API Key Management' : 'API Key 管理' }).first()
      const keyMore = keyPanel.getByRole('button', { name: loadMoreName, exact: true })
      await expect(keyPanel.getByText('Pagination key first', { exact: true })).toBeVisible()
      const firstSecret = 'mk_pagination_secret_first'
      await expect(keyPanel.getByText(firstSecret, { exact: true })).toBeVisible()
      await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (value: string) => document.documentElement.setAttribute('data-copied-key', value),
        },
      }))
      const copyKeyName = locale === 'en'
        ? 'Copy API key Pagination key first'
        : '复制 API Key：Pagination key first'
      await keyPanel.getByRole('button', { name: copyKeyName, exact: true }).click()
      await expect(page.locator('html')).toHaveAttribute('data-copied-key', firstSecret)
      await keyMore.focus()
      await page.keyboard.press('Enter')
      await expect(keyMore).toHaveAttribute('aria-busy', 'true')
      await expect(keyMore).toBeDisabled()
      releaseKeyPage!()
      await expect(keyMore).toBeEnabled()
      await expect(page.getByText(locale === 'en' ? 'Failed to load more items' : '加载更多内容失败', { exact: true }).first()).toBeVisible()
      await expect(keyPanel.getByText('Pagination key first', { exact: true })).toHaveCount(1)
      await keyMore.focus()
      await page.keyboard.press('Enter')
      await expect(keyPanel.getByText('Pagination key older', { exact: true })).toBeVisible()
      await expect(keyPanel.getByText('Pagination key first', { exact: true })).toHaveCount(1)
      await expect(keyMore).toHaveCount(0)
      await keyPanel.screenshot({ path: testInfo.outputPath(`${locale}-${theme}-keys.png`), animations: 'disabled' })

      await page.goto(`/${locale}/mailbox`)
      const mailbox = page.locator('.fluent-list-item').filter({ hasText: 'pagination@test.example.com' })
      await expect(mailbox).toBeVisible()
      const mailboxShare = mailbox.locator('button').filter({ has: page.locator('svg.lucide-share2') })
      await mailboxShare.click()
      const dialog = page.getByRole('dialog')
      const checkShares = async (kind: 'mailbox' | 'message', trigger: Locator) => {
        const more = dialog.getByRole('button', { name: loadMoreName, exact: true })
        await expect(dialog.locator(`a[href$="pagination-${kind}-first"]`)).toBeVisible()
        await more.focus()
        await page.keyboard.press('Enter')
        await expect(dialog.locator(`a[href$="pagination-${kind}-older"]`)).toBeVisible()
        await expect(dialog.locator(`a[href$="pagination-${kind}-first"]`)).toHaveCount(1)
        await expect(more).toHaveCount(0)
        expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
        await dialog.screenshot({ path: testInfo.outputPath(`${locale}-${theme}-${kind}-shares.png`), animations: 'disabled' })
        await page.keyboard.press('Escape')
        await expect(dialog).toBeHidden()
        // Radix restores focus after the closing transition; do not race the next Enter.
        await expect(trigger).toBeFocused()
      }
      await checkShares('mailbox', mailboxShare)
      const selectMailbox = mailbox.getByRole('button').filter({ hasText: 'pagination@test.example.com' })
      await selectMailbox.focus()
      await page.keyboard.press('Enter')
      const message = page.locator('.fluent-list-item').filter({ hasText: 'Pagination message' })
      await expect(message).toBeVisible()
      const messageShare = message.locator('button').filter({ has: page.locator('svg.lucide-share2') })
      await messageShare.click()
      await checkShares('message', messageShare)
      expect(requestedCursors).toEqual(['key cursor+/=', 'key cursor+/=', 'mailbox cursor+/=', 'message cursor+/='])
      expect(keyPageAttempts).toBe(2)
    })

    test(`${locale} API key mutations preserve loaded pages and focus in ${theme}`, async ({ page }, testInfo) => {
      await page.addInitScript(value => localStorage.setItem('temp-mail-theme', value), theme)
      const scriptErrors = collectScriptErrors(page)
      await registerThroughUi(page, locale, scriptErrors)

      const date = '2030-01-02T15:04:05.000Z'
      const key = (id: string, name = `Mutation key ${id}`, enabled = true) => ({
        id,
        name,
        key: `mk_mutation_secret_${id}`,
        createdAt: date,
        expiresAt: null,
        enabled,
      })
      const serverKeys = Array.from({ length: 11 }, (_, index) => key(`key-${index + 1}`))
      const requestedCursors: string[] = []
      let delayNextListRefresh = false
      let resolveStaleRefreshStarted!: () => void
      const staleRefreshStarted = new Promise<void>(resolve => { resolveStaleRefreshStarted = resolve })
      let releaseStaleRefresh!: () => void
      const staleRefreshRelease = new Promise<void>(resolve => { releaseStaleRefresh = resolve })
      let resolveStaleRefreshCompleted!: () => void
      const staleRefreshCompleted = new Promise<void>(resolve => { resolveStaleRefreshCompleted = resolve })
      let delayNextPatch = false
      const createPatchGate = () => {
        let resolveStarted!: () => void
        let release!: () => void
        return {
          started: new Promise<void>(resolve => { resolveStarted = resolve }),
          releasePromise: new Promise<void>(resolve => { release = resolve }),
          markStarted: () => resolveStarted(),
          release: () => release(),
        }
      }
      let patchGate = createPatchGate()

      const keyPage = (cursor: string | null) => {
        const cursorIndex = cursor ? serverKeys.findIndex(item => item.id === cursor) : -1
        const start = cursorIndex >= 0 ? cursorIndex + 1 : 0
        const apiKeys = serverKeys.slice(start, start + 2).map(item => ({ ...item }))
        const nextCursor = start + apiKeys.length < serverKeys.length ? apiKeys.at(-1)?.id ?? null : null
        return { apiKeys, nextCursor }
      }

      await page.route('**/api/**', async route => {
        const request = route.request()
        const url = new URL(request.url())
        if (url.pathname === '/api/api-keys' && request.method() === 'GET') {
          const cursor = url.searchParams.get('cursor')
          if (cursor !== null) requestedCursors.push(cursor)
          const response = keyPage(cursor)
          if (cursor === null && delayNextListRefresh) {
            delayNextListRefresh = false
            resolveStaleRefreshStarted()
            await staleRefreshRelease
            await route.fulfill({ json: response })
            resolveStaleRefreshCompleted()
            return
          }
          await route.fulfill({ json: response })
          return
        }
        if (url.pathname === '/api/api-keys' && request.method() === 'POST') {
          const body = request.postDataJSON() as { name: string }
          serverKeys.unshift(key('created', body.name))
          delayNextListRefresh = true
          await route.fulfill({ json: { key: 'mk_created_once' } })
          return
        }
        if (url.pathname.startsWith('/api/api-keys/') && request.method() === 'PATCH') {
          const id = url.pathname.split('/').at(-1)
          const body = request.postDataJSON() as { enabled: boolean }
          if (delayNextPatch) {
            delayNextPatch = false
            const gate = patchGate
            gate.markStarted()
            await gate.releasePromise
          }
          const record = serverKeys.find(item => item.id === id)
          if (record) record.enabled = body.enabled
          await route.fulfill({ json: { success: true } })
          return
        }
        if (url.pathname.startsWith('/api/api-keys/') && request.method() === 'DELETE') {
          const id = url.pathname.split('/').at(-1)
          const index = serverKeys.findIndex(item => item.id === id)
          if (index >= 0) serverKeys.splice(index, 1)
          await route.fulfill({ json: { success: true } })
          return
        }
        if (url.pathname === '/api/emails') {
          await route.fulfill({ json: { emails: [], total: 0, nextCursor: null } })
          return
        }
        if (url.pathname === '/api/webhook') {
          await route.fulfill({ json: { enabled: false, url: '' } })
          return
        }
        await route.continue()
      })

      await page.goto(`/${locale}/profile`)
      await expectProfileReady(page, locale, scriptErrors)
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`))
      const keyPanel = page.locator('.fluent-panel').filter({ hasText: locale === 'en' ? 'API Key Management' : 'API Key 管理' }).first()
      const loadMoreName = locale === 'en' ? 'Load more' : '加载更多'
      const createName = locale === 'en' ? 'Create API Key' : '创建 API Key'
      const keyNameLabel = locale === 'en' ? 'Key Name' : '密钥名称'
      await expect(keyPanel.getByText('Mutation key key-1', { exact: true })).toBeVisible()

      // Load two pages before mutating. The boundary after key-4 must survive
      // creation and an older-row toggle while a stale first-page refresh waits.
      const secondPageButton = keyPanel.getByRole('button', { name: loadMoreName, exact: true })
      await secondPageButton.focus()
      await page.keyboard.press('Enter')
      await expect(keyPanel.getByText('Mutation key key-3', { exact: true })).toBeVisible()
      await expect(keyPanel.getByText('Mutation key key-4', { exact: true })).toBeVisible()
      await expect(keyPanel.getByRole('button', { name: loadMoreName, exact: true })).toBeVisible()

      // Simulate a change made in another tab before the next head refresh.
      serverKeys.find(item => item.id === 'key-1')!.enabled = false
      await keyPanel.getByRole('button', { name: createName, exact: true }).click()
      const dialog = page.getByRole('dialog')
      const createInput = dialog.getByLabel(keyNameLabel, { exact: true })
      await createInput.fill('Created during pagination')
      await createInput.press('Enter')
      await expect(dialog.getByRole('heading', { name: locale === 'en' ? 'API key created successfully' : 'API Key 创建成功' })).toBeVisible()
      await staleRefreshStarted
      await dialog.getByRole('button', { name: locale === 'en' ? 'OK' : '确定', exact: true }).click()
      await expect(dialog).toBeHidden()

      const targetName = 'Mutation key key-3'
      const toggleName = locale === 'en' ? `Enable API key ${targetName}` : `启用 API Key ${targetName}`
      const olderToggle = keyPanel.getByRole('switch', { name: toggleName, exact: true })
      await olderToggle.focus()
      delayNextPatch = true
      await page.keyboard.press('Space')
      await patchGate.started
      await expect(olderToggle).toBeDisabled()
      await expect(olderToggle.locator('xpath=../..')).toHaveAttribute('aria-busy', 'true')
      patchGate.release()
      await expect(olderToggle).toBeEnabled()
      await expect(olderToggle).toHaveAttribute('aria-checked', 'false')
      await expect(olderToggle).toBeFocused()
      await expect(keyPanel.getByText('Created during pagination', { exact: true })).toBeVisible()
      const refreshedToggleName = locale === 'en'
        ? 'Enable API key Mutation key key-1'
        : '启用 API Key Mutation key key-1'
      const refreshedToggle = keyPanel.getByRole('switch', { name: refreshedToggleName, exact: true })
      await expect(refreshedToggle).toHaveAttribute('aria-checked', 'false')
      await refreshedToggle.focus()
      await page.keyboard.press('Space')
      await expect(refreshedToggle).toHaveAttribute('aria-checked', 'true')

      // The older create refresh resolves after the mutation refresh. It must
      // neither discard loaded pages nor undo the keyboard toggle.
      releaseStaleRefresh()
      await staleRefreshCompleted
      await expect(keyPanel.getByRole('switch', { name: toggleName, exact: true })).toHaveAttribute('aria-checked', 'false')
      await expect(refreshedToggle).toHaveAttribute('aria-checked', 'true')
      for (const id of ['key-1', 'key-2', 'key-3', 'key-4']) {
        await expect(keyPanel.getByText(`Mutation key ${id}`, { exact: true })).toHaveCount(1)
      }

      // The third page after the mutations must continue after key-4, keep the
      // boundary, and leave another page available instead of restarting.
      const afterCreateLoadMore = keyPanel.getByRole('button', { name: loadMoreName, exact: true })
      await afterCreateLoadMore.focus()
      await page.keyboard.press('Enter')
      await expect(keyPanel.getByText('Mutation key key-5', { exact: true })).toBeVisible()
      await expect(keyPanel.getByText('Mutation key key-6', { exact: true })).toBeVisible()
      await expect(keyPanel.getByRole('button', { name: loadMoreName, exact: true })).toBeVisible()
      expect(requestedCursors).toEqual(['key-2', 'key-4'])

      const deletedName = 'Mutation key key-5'
      const deleteName = locale === 'en' ? `Delete API key ${deletedName}` : `删除 API Key ${deletedName}`
      const deleteButton = keyPanel.getByRole('button', { name: deleteName, exact: true })
      const deleteRefresh = page.waitForResponse(response => {
        const url = new URL(response.url())
        return response.request().method() === 'GET' && url.pathname === '/api/api-keys' && !url.searchParams.has('cursor')
      })
      await deleteButton.focus()
      await page.keyboard.press('Enter')
      await expect(keyPanel.getByText(deletedName, { exact: true })).toHaveCount(0)
      await deleteRefresh
      for (const id of ['key-1', 'key-2', 'key-3', 'key-4', 'key-6']) {
        await expect(keyPanel.getByText(`Mutation key ${id}`, { exact: true })).toHaveCount(1)
      }

      // Deleting an older page-three row must leave its cursor usable.
      const afterDeleteLoadMore = keyPanel.getByRole('button', { name: loadMoreName, exact: true })
      await afterDeleteLoadMore.focus()
      await page.keyboard.press('Enter')
      await expect(keyPanel.getByText('Mutation key key-7', { exact: true })).toBeVisible()
      await expect(keyPanel.getByText('Mutation key key-8', { exact: true })).toBeVisible()
      await expect(keyPanel.getByRole('button', { name: loadMoreName, exact: true })).toBeVisible()
      expect(requestedCursors).toEqual(['key-2', 'key-4', 'key-6'])

      // If focus moves elsewhere while a toggle is pending, the row must not
      // steal focus back when its enabled state commits.
      const keySevenToggleName = locale === 'en'
        ? 'Enable API key Mutation key key-7'
        : '启用 API Key Mutation key key-7'
      const keySevenToggle = keyPanel.getByRole('switch', { name: keySevenToggleName, exact: true })
      const loadMoreAfterMutation = keyPanel.getByRole('button', { name: loadMoreName, exact: true })
      await keySevenToggle.focus()
      patchGate = createPatchGate()
      delayNextPatch = true
      await page.keyboard.press('Space')
      await patchGate.started
      await expect(keySevenToggle).toBeDisabled()
      await loadMoreAfterMutation.focus()
      patchGate.release()
      await expect(keySevenToggle).toBeEnabled()
      await expect(keySevenToggle).toHaveAttribute('aria-checked', 'false')
      await expect(loadMoreAfterMutation).toBeFocused()

      await page.getByRole('region', { name: 'Notifications (F8)' }).getByRole('button').click()
      await keyPanel.evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }))
      await keyPanel.screenshot({ path: testInfo.outputPath(`${locale}-${theme}-mutated-api-keys.png`), animations: 'disabled' })
    })
  }
}
