import test from "node:test"
import assert from "node:assert/strict"
import { signOutAfterClearingCaches } from "../app/lib/private-cache"

for (const failure of ["none", "keys", "delete", "unavailable"]) {
  test(`logout completes when cache access is ${failure}`, async t => {
    const events: string[] = []
    const storage = {
      async keys() {
        events.push("keys")
        if (failure === "keys") throw new Error("Storage access denied")
        return ["private"]
      },
      async delete() {
        events.push("delete")
        if (failure === "delete") throw new Error("Storage access denied")
        return true
      },
    }
    for (const [name, value] of Object.entries({ window: failure === "unavailable" ? {} : { caches: storage }, caches: storage })) {
      const original = Object.getOwnPropertyDescriptor(globalThis, name)
      Object.defineProperty(globalThis, name, { configurable: true, value })
      t.after(() => {
        if (original) Object.defineProperty(globalThis, name, original)
        else Reflect.deleteProperty(globalThis, name)
      })
    }
    const warning = t.mock.method(console, "warn", () => {})
    await signOutAfterClearingCaches(async () => { events.push("signOut") })
    assert.deepEqual(events, failure === "unavailable" ? ["signOut"] : failure === "keys" ? ["keys", "signOut"] : ["keys", "delete", "signOut"])
    assert.equal(warning.mock.callCount(), failure === "keys" || failure === "delete" ? 1 : 0)
  })
}
