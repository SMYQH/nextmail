import { expect, test } from '@playwright/test'

/**
 * The public base URL drives canonical, hreflang and Open Graph links.
 *
 * The assertions stay independent of the configured value: they require one
 * absolute public origin for every link, which is what a configured base URL
 * guarantees and a request-host fallback does not.
 */
test('canonical, hreflang and Open Graph links share one public origin', async ({ page }) => {
  await page.goto('/en/login')

  const canonical = page.locator('link[rel="canonical"]')
  await expect(canonical).toHaveCount(1)
  const canonicalHref = await canonical.getAttribute('href')
  expect(canonicalHref).toBeTruthy()
  const canonicalUrl = new URL(canonicalHref!)
  expect(canonicalUrl.pathname).toBe('/en')

  const alternates = page.locator('link[rel="alternate"][hreflang]')
  const alternateCount = await alternates.count()
  expect(alternateCount).toBeGreaterThan(0)
  for (let index = 0; index < alternateCount; index += 1) {
    const href = await alternates.nth(index).getAttribute('href')
    expect(href).toBeTruthy()
    expect(new URL(href!).origin).toBe(canonicalUrl.origin)
  }

  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', canonicalHref!)
})