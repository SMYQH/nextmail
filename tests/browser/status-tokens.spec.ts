import { expect, test } from '@playwright/test'
import { collectScriptErrors, expectProfileReady, readSession, registerThroughUi } from './support'

test.use({ serviceWorkers: 'block' })

function relativeLuminance(rgb: number[]) {
  const [r, g, b] = rgb.map(value => {
    const channel = value / 255
    return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(foreground: number[], background: number[]) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background))
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

async function effectiveBackground(element: import('@playwright/test').Locator) {
  return element.evaluate(node => {
    const parse = (value: string) => {
      const match = value.match(/rgba?\(([^)]+)\)/)
      if (!match) return null
      const parts = match[1].split(/[,\s/]+/).filter(Boolean).map(Number)
      return { rgb: parts.slice(0, 3), alpha: parts.length > 3 ? parts[3] : 1 }
    }
    let current: Element | null = node
    while (current) {
      const style = getComputedStyle(current)
      const color = parse(style.backgroundColor)
      if (color && color.alpha > 0) {
        const parent = current.parentElement
        const parentColor = parent ? parse(getComputedStyle(parent).backgroundColor) : null
        const alpha = parentColor ? color.alpha + parentColor.alpha * (1 - color.alpha) : color.alpha
        return {
          rgb: color.rgb.map((value, index) => value * color.alpha + (parentColor?.rgb[index] ?? 255) * (1 - color.alpha)),
        }
      }
      current = current.parentElement
    }
    return { rgb: [255, 255, 255] }
  })
}

for (const locale of ['en', 'zh-CN'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${locale} status colours use theme tokens in ${theme}`, async ({ page }, testInfo) => {
      await page.addInitScript(value => localStorage.setItem('temp-mail-theme', value), theme)
      const scriptErrors = collectScriptErrors(page)
      await registerThroughUi(page, locale, scriptErrors)
      const session = await readSession(page)
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
        } else if (path === '/api/roles/users') {
          json = { users: [{ id: 'token-user', name: 'Token fixture', username: 'token_fixture', email: 'token@example.invalid', image: null, role: 'emperor', allowedDomains: null }], total: 1, page: 1, pageSize: 10 }
        } else if (path === '/api/config/email-service') {
          json = { domains: { 'test.example.com': { enabled: true, apiKey: '', hasApiKey: false, configured: true } }, roleLimits: { duke: -1, knight: -1 } }
        } else if (path === '/api/webhook') {
          json = { enabled: false, url: '' }
        } else {
          await route.continue()
          return
        }
        await route.fulfill({ json })
      })
      await page.goto(`/${locale}/profile`)
      // The panel renders from the client session, so the page has to hydrate
      // before the panel can appear at all.
      await expectProfileReady(page, locale, scriptErrors)
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`))

      const tokenColors = await page.evaluate(() => {
        const read = (name: string) => {
          const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
          const probe = document.createElement('div')
          probe.style.color = `hsl(${value})`
          document.body.appendChild(probe)
          const color = getComputedStyle(probe).color
          probe.remove()
          return color
        }
        return {
          primary: read('--primary'),
          success: read('--success'),
          warning: read('--warning'),
          destructive: read('--destructive'),
        }
      })

      const panel = page.locator('.fluent-info-panel').filter({ hasText: locale === 'en' ? 'Fixed role limits' : '固定权限规则' })
      await expect(panel).toBeVisible()
      const dots = panel.locator('span.rounded-full')
      await expect(dots).toHaveCount(3)
      const dotColors = await dots.evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor))
      expect(dotColors[0], 'the panel header dot must use the primary token').toBe(tokenColors.primary)
      expect(dotColors[1], 'the allowed-role dot must use the success token').toBe(tokenColors.success)
      expect(dotColors[2], 'the blocked-role dot must use the destructive token').toBe(tokenColors.destructive)

      const header = page.locator('p').filter({ hasText: locale === 'en' ? 'Configurable role permissions' : '可配置的角色权限' })
      await expect(header).toBeVisible()
      const headerDot = header.locator('..').locator('span.rounded-full')
      await expect(headerDot).toHaveCSS('background-color', tokenColors.warning)

      const badge = page.locator('div').filter({ hasText: /^Emperor$|^皇帝$/ }).last()
      await expect(badge).toBeVisible()
      const badgeColor = await badge.evaluate(node => getComputedStyle(node).color)
      expect(badgeColor, 'the emperor badge must use the warning token').toBe(tokenColors.warning)
      const background = await effectiveBackground(badge)
      const ratio = contrast(
        (badgeColor.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number),
        background.rgb
      )
      expect(ratio, `the emperor badge needs 4.5:1, measured ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
      await page.screenshot({ path: testInfo.outputPath(`${locale}-${theme}-status-tokens.png`), animations: 'disabled' })
    })
  }
}
