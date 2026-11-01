import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const loader = pathToFileURL(require.resolve('tsx/esm')).href
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const configUrl = pathToFileURL(resolve(root, 'next.config.ts')).href

function probe(kind: 'regexp' | 'array' | 'string') {
  const script = `
    import { mock } from 'node:test';
    import { resolve } from 'node:path';
    mock.module('next-intl/plugin', { defaultExport: () => config => config });
    mock.module('@opennextjs/cloudflare', { namedExports: { initOpenNextCloudflareForDev() {} } });
    const { default: config } = await import(${JSON.stringify(configUrl)});
    const kind = ${JSON.stringify(kind)};
    const ignored = kind === 'regexp' ? /node_modules/i : kind === 'array' ? ['**/legacy/**'] : '**/legacy/**';
    const originalWatch = Object.freeze({ ignored, aggregateTimeout: 5, poll: 123 });
    const original = { watchOptions: originalWatch };
    const changed = config.webpack ? config.webpack(original, { dev: true }) : original;
    const rule = changed.watchOptions.ignored;
    const artifacts = ['.wrangler', '.test'];
    const runtimePaths = artifacts.map(name => resolve(name, 'nested', 'runtime.data'));
    const sourcePaths = ['app/[locale]/page.tsx', 'app/lib/auth.ts', 'next.config.ts'].map(name => resolve(name));
    const matches = value => rule instanceof RegExp ? rule.test(value) : (typeof rule === 'string' ? [rule] : rule).some(pattern => {
      const normalized = value.replaceAll('\\\\', '/');
      return normalized === pattern || (pattern.endsWith('/**') && normalized.startsWith(pattern.slice(0, -2)));
    });
    const production = { watchOptions: originalWatch };
    const productionResult = config.webpack ? config.webpack(production, { dev: false }) : production;
    console.log(JSON.stringify({
      runtimeIgnored: runtimePaths.map(matches),
      sourceIgnored: sourcePaths.map(matches),
      existingPreserved: rule instanceof RegExp ? rule.test(resolve('NODE_MODULES', 'module.js')) && rule.flags === ignored.flags : rule.includes('**/legacy/**'),
      originalUntouched: originalWatch.ignored === ignored && originalWatch.poll === 123,
      aggregateTimeout: changed.watchOptions.aggregateTimeout,
      poll: changed.watchOptions.poll,
      productionUntouched: productionResult === production && production.watchOptions === originalWatch,
    }));
  `
  const result = spawnSync(process.execPath, ['--import', loader, '--experimental-test-module-mocks', '--input-type=module', '-e', script], {
    cwd: root, encoding: 'utf8', timeout: 30_000, env: { ...process.env, NODE_ENV: 'test' },
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

for (const kind of ['regexp', 'array', 'string'] as const) {
  test(`development watcher ignores runtime output and preserves ${kind} defaults`, () => {
    const result = probe(kind)
    assert.deepEqual(result.runtimeIgnored, [true, true])
    assert.deepEqual(result.sourceIgnored, [false, false, false])
    assert.equal(result.existingPreserved, true)
    assert.equal(result.originalUntouched, true)
    assert.equal(result.aggregateTimeout, 5)
    assert.equal(result.poll, 123)
    assert.equal(result.productionUntouched, true)
  })
}
