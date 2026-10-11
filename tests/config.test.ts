import test from "node:test"
import assert from "node:assert/strict"
import { useConfigStore } from "../app/hooks/use-config"

const configuration = { emailDomains: " example.com, example.org ", maxEmails: 12 }

test("config retries stop after three failures and an explicit retry recovers", async t => {
  useConfigStore.setState({ config: null, error: null, loading: false })
  let requests = 0
  let online = false
  t.mock.method(globalThis, "fetch", async () => {
    requests++
    if (!online) throw new TypeError("Network unavailable")
    return Response.json(configuration)
  })

  await useConfigStore.getState().fetch()
  assert.equal(requests, 3)
  assert.equal(useConfigStore.getState().loading, false)
  assert.ok(useConfigStore.getState().error)
  assert.equal(useConfigStore.getState().config, null)

  online = true
  await useConfigStore.getState().fetch()
  assert.equal(requests, 4)
  assert.equal(useConfigStore.getState().error, null)
  assert.deepEqual(useConfigStore.getState().config?.emailDomainsArray, ["example.com", "example.org"])
})

test("config requests from multiple consumers share the in-flight request", async t => {
  useConfigStore.setState({ config: null, error: "Previous failure", loading: false })
  let requests = 0
  let respond!: (response: Response) => void
  t.mock.method(globalThis, "fetch", () => {
    requests++
    return new Promise<Response>(resolve => { respond = resolve })
  })
  const first = useConfigStore.getState().fetch()
  await useConfigStore.getState().fetch()
  assert.equal(requests, 1)
  respond(Response.json(configuration))
  await first
  assert.equal(useConfigStore.getState().loading, false)
  assert.equal(useConfigStore.getState().error, null)
})
