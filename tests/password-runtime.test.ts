import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { resolve } from 'node:path'

test('password authentication imports and compares in a workerd request without module-scope crypto', async () => {
  const passwordModule = resolve('app/lib/password.ts')
  const source = `
    import { comparePassword, getDummyPasswordHash } from ${JSON.stringify(passwordModule)}

    export default {
      async fetch() {
        const dummyHash = await getDummyPasswordHash()
        const matched = await comparePassword('unknown-user-password', dummyHash)
        return Response.json({
          dummyHashIsCost10: /^bcrypt-sha256:\\$2b\\$10\\$/.test(dummyHash),
          matched,
          moduleScopeDigestCalls: globalThis.__passwordModuleEvaluation.digestCalls,
        })
      },
    }
  `
  const bundle = await build({
    stdin: { contents: source, resolveDir: process.cwd(), sourcefile: 'password-runtime.ts', loader: 'ts' },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    write: false,
    banner: {
      js: `
        globalThis.__passwordModuleEvaluation = { active: true, digestCalls: 0 }
        const __digest = crypto.subtle.digest.bind(crypto.subtle)
        Object.defineProperty(crypto.subtle, 'digest', {
          configurable: true,
          value: (...args) => {
            if (globalThis.__passwordModuleEvaluation.active) globalThis.__passwordModuleEvaluation.digestCalls += 1
            return __digest(...args)
          },
        })
      `,
    },
    footer: { js: 'globalThis.__passwordModuleEvaluation.active = false' },
  })
  const workerConfig = {
    name: 'password-runtime',
    compatibilityDate: '2025-01-01',
    manifest: {
      mainModule: 'index.js',
      modules: { 'index.js': { type: 'esm' as const, contents: bundle.outputFiles[0].text } },
    },
  }
  const miniflare = new Miniflare({ workers: [{ config: workerConfig }] })

  try {
    const response = await miniflare.dispatchFetch('http://localhost/')
    assert.equal(response.status, 200, await response.clone().text())
    assert.deepEqual(await response.json(), {
      dummyHashIsCost10: true,
      matched: false,
      moduleScopeDigestCalls: 0,
    })
  } finally {
    await miniflare.dispose()
  }
})
