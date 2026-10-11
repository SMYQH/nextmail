"use client"

export async function signOutAfterClearingCaches(signOut: () => Promise<unknown>) {
  try {
    await clearPrivateCaches()
  } catch (error) {
    console.warn("Could not clear private caches before signing out", error)
  } finally {
    await signOut()
  }
}

export async function clearPrivateCaches() {
  if ("caches" in window) {
    const names = await caches.keys()
    await Promise.all(names.map(name => caches.delete(name)))
  }
}
