import test from 'node:test'
import assert from 'node:assert/strict'
import { overrideKV, type TestKV } from './helpers/kv-overrides'

function namespace(values: Map<string, string>): TestKV {
  return {
    get: async key => values.get(key) ?? null,
    put: async (key, value) => { values.set(key, value) },
    delete: async key => { values.delete(key) },
  }
}

test('temporary Turnstile overrides restore configured values, blanks, and missing keys exactly', async () => {
  for (const entries of [[], [['TURNSTILE_ENABLED', 'false']], [
    ['TURNSTILE_ENABLED', 'true'], ['TURNSTILE_SITE_KEY', '  developer-site-key\n'],
  ], [['TURNSTILE_SITE_KEY', '']]] as [string, string][][]) {
    const values = new Map(entries)
    const original = new Map(values)
    const restore = await overrideKV(namespace(values), { TURNSTILE_ENABLED: 'true', TURNSTILE_SITE_KEY: 'test-site-key' })
    assert.equal(values.get('TURNSTILE_SITE_KEY'), 'test-site-key')
    await restore()
    assert.deepEqual(values, original)
  }
})

test('failed Turnstile setup restores earlier writes and leaves no test configuration', async () => {
  const values = new Map([['TURNSTILE_ENABLED', 'false'], ['TURNSTILE_SITE_KEY', 'original-key']])
  const original = new Map(values)
  const kv = namespace(values)
  const put = kv.put
  kv.put = async (key, value) => {
    if (value === 'test-site-key') throw new Error('simulated setup failure')
    return put(key, value)
  }
  await assert.rejects(overrideKV(kv, { TURNSTILE_ENABLED: 'true', TURNSTILE_SITE_KEY: 'test-site-key' }), /setup failure/)
  assert.deepEqual(values, original)
})

test('Turnstile cleanup attempts every key even if a restoration fails', async () => {
  const values = new Map([['TURNSTILE_ENABLED', 'false'], ['TURNSTILE_SITE_KEY', 'original-key']])
  const kv = namespace(values)
  const restore = await overrideKV(kv, { TURNSTILE_ENABLED: 'true', TURNSTILE_SITE_KEY: 'test-site-key' })
  const put = kv.put
  kv.put = async (key, value) => {
    if (key === 'TURNSTILE_ENABLED') throw new Error('simulated cleanup failure')
    return put(key, value)
  }
  await assert.rejects(restore(), AggregateError)
  assert.equal(values.get('TURNSTILE_SITE_KEY'), 'original-key')
})
