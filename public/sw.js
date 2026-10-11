/* This worker intentionally stores no responses. It also replaces old next-pwa
 * workers and removes their private API/page caches on activation. */
self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    await Promise.all((await caches.keys()).map(name => caches.delete(name)))
    await self.clients.claim()
  })())
})
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url)
  if (url.origin === self.location.origin &&
      (url.pathname.startsWith("/api/") || event.request.mode === "navigate" || event.request.headers.has("RSC"))) {
    event.respondWith(fetch(event.request, { cache: "no-store" }))
  }
})
