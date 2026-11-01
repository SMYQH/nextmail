import { expect, test, type Locator } from '@playwright/test'
import { collectScriptErrors, expectProfileReady, readSession, registerThroughUi } from './support'

test.use({ serviceWorkers: 'block' })

for (const locale of ['en', 'zh-CN'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${locale} busy controls retain labels and geometry in ${theme}`, async ({ page }, testInfo) => {
      await page.addInitScript(value => localStorage.setItem('temp-mail-theme', value), theme)
      const scriptErrors = collectScriptErrors(page)
      await registerThroughUi(page, locale, scriptErrors)
      const session = await readSession(page)
      const held = new Map<string, { release: () => void; ready: Promise<void> }>()
      const counts = new Map<string, number>()
      const copy = locale === 'en' ? {
        save: 'Save', test: 'Test', create: 'Create API Key', name: 'Enter key name',
        saveDomains: 'Save domains', deleteUser: 'Delete User', delete: 'Delete',
      } : {
        save: '保存', test: '测试', create: '创建 API Key', name: '输入密钥名称',
        saveDomains: '保存域名权限', deleteUser: '删除用户', delete: '删除',
      }
      // Elevate only the mocked client session to render the admin controls.
      // The real account remains a duke; all writes below are intercepted.
      await page.route('**/api/**', async route => {
        const request = route.request()
        const path = new URL(request.url()).pathname
        const pending = held.get(path)
        if (request.method() !== 'GET') {
          expect(pending, `unexpected write: ${path}`).toBeDefined()
          counts.set(path, (counts.get(path) ?? 0) + 1)
          await pending!.ready
          await route.fulfill({ status: 500, json: { error: 'synthetic_failure' } })
        } else if (path === '/api/auth/session') {
          await route.fulfill({ json: { ...session, user: { ...session.user, roles: [{ name: 'emperor' }] } } })
        } else if (path === '/api/webhook') {
          await route.fulfill({ json: { enabled: true, url: 'https://webhook.example.invalid/events' } })
        } else if (path === '/api/api-keys') {
          await route.fulfill({ json: { apiKeys: [] } })
        } else if (path === '/api/roles/users') {
          await route.fulfill({ json: { users: [{
            id: 'synthetic-busy-user', name: 'Busy fixture user', username: 'busy_fixture',
            email: null, image: null, role: 'knight', allowedDomains: [],
          }], total: 1, page: 1, pageSize: 10 } })
        } else {
          await route.continue()
        }
      })
      // Compile the profile route before the browser visits it, so the first
      // visit does not race the on demand compilation of the dev server.
      await page.request.get(`/${locale}/profile`)
      await page.goto(`/${locale}/profile`)
      await expectProfileReady(page, locale, scriptErrors)
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`))

      /**
       * Reads the button geometry.
       *
       * A Fast Refresh remount replaces the button node, so the box is read
       * through a poll that resolves the locator again and only accepts two
       * consecutive readings that agree.
       */
      async function readStableBox(button: Locator) {
        let box: { width: number; height: number } | null = null
        await expect.poll(async () => {
          const current = await button.boundingBox()
          if (!current) {
            box = null
            return 'missing'
          }
          if (box && (Math.abs(current.width - box.width) >= 0.5 || Math.abs(current.height - box.height) >= 0.5)) {
            // The node was replaced; read the fresh node again.
            box = null
            return 'remounted'
          }
          const previous = box
          box = { width: current.width, height: current.height }
          // Only two consecutive agreeing readings count as settled.
          return previous ? 'stable' : 'first'
        }, { message: 'the button geometry must settle' }).toBe('stable')
        return box!
      }

      async function checkBusy(button: Locator, path: string, label: string, screenshot: string, visibleText = true, waitForIdle = true) {
        let release = () => {}
        const ready = new Promise<void>(resolve => { release = resolve })
        held.set(path, { release, ready })
        try {
          await expect(button).toBeEnabled()
          await button.focus()
          const before = await readStableBox(button)
          expect(before).not.toBeNull()
          await page.keyboard.press('Enter')
          await expect.poll(() => counts.get(path) ?? 0).toBe(1)
          await expect(button).toBeDisabled()
          await expect(button).toHaveAttribute('aria-busy', 'true')
          await expect(button).toHaveAccessibleName(label)
          if (visibleText) await expect(button).toHaveText(label)
          await expect(button.locator('svg')).toHaveAttribute('aria-hidden', 'true')
          await expect.poll(async () => {
            const current = await button.boundingBox()
            return current !== null && Math.abs(current.width - before.width) < 0.5 && Math.abs(current.height - before.height) < 0.5
          }, { message: 'loading must not resize the button' }).toBe(true)
          await page.screenshot({ path: testInfo.outputPath(screenshot), animations: 'disabled' })
        } finally {
          release()
        }
        if (waitForIdle) {
          await expect(button).toBeEnabled()
          await expect(button).toHaveAttribute('aria-busy', 'false')
          if (visibleText) await expect(button).toHaveText(label)
        }
      }

      try {
        const webhook = page.locator('form').filter({ has: page.locator('#webhook-url') })
        await checkBusy(webhook.getByRole('button', { name: copy.save, exact: true }), '/api/webhook', copy.save, 'webhook-saving.png')
        await checkBusy(webhook.getByRole('button', { name: copy.test, exact: true }), '/api/webhook/test', copy.test, 'webhook-testing.png', false)

        await page.getByRole('button', { name: copy.create, exact: true }).click()
        const dialog = page.getByRole('dialog')
        await dialog.getByPlaceholder(copy.name, { exact: true }).fill('Busy fixture key')
        await checkBusy(dialog.getByRole('button', { name: copy.create, exact: true }), '/api/api-keys', copy.create, 'key-creating.png', true, false)
        await page.keyboard.press('Escape')
        await expect(dialog).toBeHidden()

        await page.getByRole('checkbox', { name: '@test.example.com', exact: true }).check()
        await checkBusy(page.getByRole('button', { name: copy.saveDomains, exact: true }), '/api/roles/user-domains', copy.saveDomains, 'domains-saving.png')
        await page.getByTitle(copy.deleteUser, { exact: true }).click()
        await checkBusy(page.getByRole('alertdialog').getByRole('button', { name: copy.delete, exact: true }), '/api/users/synthetic-busy-user', copy.delete, 'user-deleting.png')
        expect([...counts.values()]).toEqual([1, 1, 1, 1, 1])
      } finally {
        for (const pending of held.values()) pending.release()
      }
    })
  }
}
