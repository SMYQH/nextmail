import { expect, test } from '@playwright/test'
import { collectScriptErrors, expectProfileReady, readSession, registerThroughUi } from './support'

test.use({ serviceWorkers: 'block' })

for (const locale of ['en', 'zh-CN'] as const) {
  test(`${locale} busy indicators keep a static cue under reduced motion`, async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const scriptErrors = collectScriptErrors(page)
    await registerThroughUi(page, locale, scriptErrors)
    const session = await readSession(page)
    const address = 'reduced-motion@test.example.com'
    const holds = new Map<string, { release: () => void; ready: Promise<void> }>()
    function hold(key: string) {
      let release = () => {}
      const ready = new Promise<void>(resolve => { release = resolve })
      holds.set(key, { release, ready })
      return { release, ready }
    }
    await page.route('**/api/**', async route => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      const key = `${request.method()} ${path}`
      const pending = holds.get(key)
      let json: unknown
      if (path === '/api/auth/session') {
        json = { ...session, user: { ...session.user, roles: [{ name: 'emperor' }] } }
      } else if (path === '/api/webhook' && request.method() === 'GET') {
        json = { enabled: true, url: 'https://webhook.example.invalid/events' }
      } else if (path === '/api/emails') {
        json = { emails: [{ id: 'motion-mailbox', address, createdAt: Date.now(), expiresAt: Date.now() + 86_400_000, totalMessages: 0, unreadMessages: 0 }], total: 1, nextCursor: null }
      } else if (path === '/api/emails/motion-mailbox') {
        json = { messages: [], total: 0, unread: 0, nextCursor: null, latestCursor: '0' }
      } else if (path === '/api/emails/motion-mailbox/share') {
        json = { shares: [] }
      } else if (pending) {
        await pending.ready
        await route.fulfill({ status: 500, json: { error: 'synthetic_failure' } })
        return
      } else {
        await route.continue()
        return
      }
      if (pending) await pending.ready
      await route.fulfill({ json })
    })

    // Icon spinner inside the webhook save button.
    await page.goto(`/${locale}/profile`)
    // The webhook panel renders from the client session.
    await expectProfileReady(page, locale, scriptErrors)
    const save = page.getByRole('button', { name: locale === 'en' ? 'Save' : '保存', exact: true }).first()
    await expect(save).toBeVisible()
    const pending = hold('POST /api/webhook')
    await save.click()
    const iconSpinner = save.locator('svg')
    await expect(iconSpinner).toBeVisible()
    await expect(iconSpinner).toHaveCSS('animation-name', 'none')
    const dash = await iconSpinner.evaluate(node => getComputedStyle(node).strokeDasharray)
    expect(dash, 'an icon spinner must keep a static dashed cue').not.toBe('none')
    expect(dash).not.toBe('')
    await page.screenshot({ path: testInfo.outputPath(`${locale}-reduced-motion-icon-spinner.png`), animations: 'disabled' })
    pending.release()

    // Border spinner shown while the share list loads.
    await page.goto(`/${locale}/mailbox`)
    const row = page.locator('.fluent-list-item').filter({ hasText: address })
    const listPending = hold('GET /api/emails/motion-mailbox/share')
    await row.getByRole('button', { name: locale === 'en' ? 'Share' : '分享', exact: true }).click()
    const dialog = page.getByRole('dialog')
    const borderSpinner = dialog.locator('div.animate-spin')
    await expect(borderSpinner).toBeVisible()
    await expect(borderSpinner).toHaveCSS('animation-name', 'none')
    await expect(borderSpinner).toHaveCSS('border-style', 'dashed')
    await page.screenshot({ path: testInfo.outputPath(`${locale}-reduced-motion-border-spinner.png`), animations: 'disabled' })
    listPending.release()

    // No spinner anywhere may run an animation while reduced motion is requested.
    const animated = await page.locator('.animate-spin').evaluateAll(nodes =>
      nodes.filter(node => getComputedStyle(node).animationName !== 'none').length)
    expect(animated, 'reduced motion must not animate any spinner').toBe(0)
  })
}
