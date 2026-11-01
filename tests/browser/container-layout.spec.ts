import { expect, test } from '@playwright/test'
import { collectScriptErrors, expectClientReady, registerThroughUi } from './support'

test.use({ serviceWorkers: 'block' })

const WIDTHS = [375, 1024, 1600] as const

for (const locale of ['en', 'zh-CN'] as const) {
  test(`${locale} pages share one content column and gutter`, async ({ page }) => {
    const scriptErrors = collectScriptErrors(page)
    await registerThroughUi(page, locale, scriptErrors)

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 })
      const measurements: Array<{ page: string; content: number; logo: number }> = []

      for (const [name, path] of [
        ['home', `/${locale}`],
        ['mailbox', `/${locale}/mailbox`],
        ['profile', `/${locale}/profile`],
      ] as const) {
        await page.goto(path)
        // The panes render from the client session.
        await expectClientReady(page, locale, scriptErrors)
        await expect(page.locator('html')).toHaveClass(/\b(light|dark)\b/)
        const logo = page.locator('header a[href="/"]').first()
        await expect(logo).toBeVisible()
        const logoBox = await logo.boundingBox()
        expect(logoBox, `the header logo must be measurable on ${name}`).not.toBeNull()

        // The page content column is the element that carries the container utility.
        const column = page.locator('.container').first()
        await expect(column).toBeVisible()
        const columnBox = await column.boundingBox()
        expect(columnBox, `the content column must be measurable on ${name}`).not.toBeNull()
        // The content edge is the column box plus its own gutter.
        const gutter = await column.evaluate(node => parseFloat(getComputedStyle(node).paddingLeft) || 0)
        measurements.push({
          page: name,
          content: Math.round(columnBox!.x + gutter),
          logo: Math.round(logoBox!.x),
        })
      }

      // Every page must place its content column at the same offset as the header logo.
      for (const measurement of measurements) {
        expect(
          Math.abs(measurement.content - measurement.logo),
          `${measurement.page} content starts at ${measurement.content}px but the header logo starts at ${measurement.logo}px at ${width}px`,
        ).toBeLessThanOrEqual(1)
      }

      // The content column must be centred and share one gutter.
      const gutters = measurements.map(measurement => measurement.content)
      expect(new Set(gutters).size, `pages disagree on the left gutter at ${width}px`).toBe(1)
    }
  })
}
