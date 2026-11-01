import assert from 'node:assert/strict'
import { expect, test } from '@playwright/test'
import { collectScriptErrors, expectClientSession, readSession, registerThroughUi, sessionMarker } from './support'

test.use({ serviceWorkers: 'block' })

// Diagnose broken hydration without letting the readiness helper mask it.
test('a stale client chunk fails readiness and an explicit reload preserves the session', async ({ page }) => {
  const scriptErrors = collectScriptErrors(page)
  const username = await registerThroughUi(page, 'en', scriptErrors)

  await page.route('**/_next/static/chunks/**/*.js', route => route.abort())
  await page.goto('/en')
  await expect.poll(() => scriptErrors.length).toBeGreaterThan(0)
  await expect(sessionMarker(page, 'en')).toBeHidden()
  expect((await readSession(page)).user?.name).toBe(username)

  const brokenUrl = page.url()
  await assert.rejects(expectClientSession(page, 'en', scriptErrors), /the page must not raise client errors/)
  expect(page.url()).toBe(brokenUrl)
  await expect(sessionMarker(page, 'en')).toBeHidden()
  expect(scriptErrors.length).toBeGreaterThan(0)

  // Recovery is a deliberate test action, not a hidden retry in every spec.
  await page.unroute('**/_next/static/chunks/**/*.js')
  scriptErrors.length = 0
  await page.reload()
  await expectClientSession(page, 'en', scriptErrors)
  expect((await readSession(page)).user?.name).toBe(username)
})
