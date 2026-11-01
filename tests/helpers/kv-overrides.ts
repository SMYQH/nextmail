export interface TestKV {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<unknown>
  delete(key: string): Promise<unknown>
}

/** Temporarily overrides values while retaining exact contents and key absence. */
export async function overrideKV(kv: TestKV, values: Record<string, string>) {
  const originals = await Promise.all(Object.keys(values).map(async key => [key, await kv.get(key)] as const))
  const restore = async () => {
    const results = await Promise.allSettled(originals.map(([key, value]) =>
      value === null ? kv.delete(key) : kv.put(key, value)))
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (errors.length) throw new AggregateError(errors, 'Could not restore test KV overrides')
  }
  try {
    for (const [key, value] of Object.entries(values)) await kv.put(key, value)
  } catch (error) {
    try {
      await restore()
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], 'Could not apply and restore test KV overrides')
    }
    throw error
  }
  return restore
}
