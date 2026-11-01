import { expect, test } from '@playwright/test'
import { getPlatformProxy, type PlatformProxy } from 'wrangler'
import { resolve } from 'node:path'
import { overrideKV, type TestKV } from '../helpers/kv-overrides'

const root = process.cwd()
let platform: PlatformProxy<{ SITE_CONFIG: TestKV }> | undefined
let restore: (() => Promise<void>) | undefined

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  platform = await getPlatformProxy<{ SITE_CONFIG: TestKV }>({
    configPath: resolve(root, 'wrangler.json'),
    persist: { path: resolve(root, '.wrangler/state/v3') },
    remoteBindings: false,
    envFiles: [],
  })
  restore = await overrideKV(platform.env.SITE_CONFIG, {
    TURNSTILE_ENABLED: 'true',
    TURNSTILE_SITE_KEY: 'test-site-key',
  })
})

test.afterAll(async () => {
  try {
    await restore?.()
  } finally {
    await platform?.dispose()
    platform = undefined
    restore = undefined
  }
})

test.use({ serviceWorkers: 'block' })

for (const locale of ['en', 'zh-CN'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${locale} turnstile follows the application theme in ${theme}`, async ({ page }) => {
      await page.addInitScript(value => localStorage.setItem('temp-mail-theme', value), theme)
      await page.addInitScript(() => {
        const calls: Array<Record<string, unknown>> = []
        ;(window as unknown as { __turnstileCalls: Array<Record<string, unknown>> }).__turnstileCalls = calls
        ;(window as unknown as { turnstile: unknown }).turnstile = {
          render: (container: HTMLElement, options: Record<string, unknown>) => {
            calls.push(options)
            const placeholder = document.createElement('div')
            placeholder.textContent = 'turnstile stub'
            container.appendChild(placeholder)
            return 'stub-widget-id'
          },
          remove: () => undefined,
          reset: () => undefined,
        }
      })
      await page.goto(`/${locale}/login`)
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`))

      const calls = await page.evaluate(() => (window as unknown as { __turnstileCalls: Array<Record<string, unknown>> }).__turnstileCalls)
      expect(calls.length, 'the widget must render').toBeGreaterThan(0)
      const options = calls[0]
      expect(options.theme, 'the widget must follow the application theme, not the OS theme').toBe(theme)
      expect(Object.keys(options).sort(), 'no opaque state may be added').toEqual([
        'callback', 'error-callback', 'expired-callback', 'sitekey', 'theme',
      ])

      // Changing the stored theme re-renders the widget with the new theme.
      const before = calls.length
      const nextTheme = theme === 'dark' ? 'light' : 'dark'
      await page.evaluate(value => {
        localStorage.setItem('temp-mail-theme', value)
        window.dispatchEvent(new StorageEvent('storage', { key: 'temp-mail-theme', newValue: value }))
      }, nextTheme)
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${nextTheme}\\b`))
      await expect.poll(async () => page.evaluate(
        () => (window as unknown as { __turnstileCalls: Array<Record<string, unknown>> }).__turnstileCalls.length
      ), { message: 'the widget must be rendered again for the new theme' }).toBeGreaterThan(before)
      const after = await page.evaluate(() => (window as unknown as { __turnstileCalls: Array<Record<string, unknown>> }).__turnstileCalls)
      expect(after[after.length - 1].theme, 'the re-rendered widget must use the new theme').toBe(nextTheme)
    })
  }
}
