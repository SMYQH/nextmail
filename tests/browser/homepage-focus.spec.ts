import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'block', reducedMotion: 'no-preference' })

for (const [locale, theme] of [['en', 'light'], ['zh-CN', 'dark']] as const) {
  test(`${locale} homepage stays visible when the tab regains focus in ${theme}`, async ({ context, page }, testInfo) => {
    await page.addInitScript(value => localStorage.setItem('temp-mail-theme', value), theme)
    await page.goto(`/${locale}`, { waitUntil: 'load' })
    const root = page.locator('html')
    const heading = page.getByRole('main').getByRole('heading', { level: 1 })
    await expect(root).toHaveClass(new RegExp(`\\b${theme}\\b`))
    await expect(root).toHaveAttribute('data-input-modality', 'keyboard')

    const otherTab = await context.newPage()
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.keyboard.press('Tab')
      await otherTab.bringToFront()
      await page.bringToFront()
      await heading.click()
      await expect(root).toHaveAttribute('data-input-modality', 'pointer')

      const hiddenOrAnimating = await page.getByRole('main').evaluate(main =>
        Array.from(main.querySelectorAll('section, .fluent-hero-card')).some(element => {
          for (let node: Element | null = element; node && node !== main; node = node.parentElement) {
            const style = getComputedStyle(node)
            if (style.opacity !== '1' || style.animationName !== 'none') return true
          }
          return false
        }),
      )
      expect(hiddenOrAnimating).toBe(false)
    }

    await expect(heading).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`${locale}-${theme}-homepage.png`) })
  })
}
