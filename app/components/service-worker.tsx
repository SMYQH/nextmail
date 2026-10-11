"use client"

import { useEffect } from "react"
import { clearPrivateCaches } from "@/lib/private-cache"

export function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return
    void clearPrivateCaches()
      .then(() => navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }))
      .catch(console.error)
  }, [])
  return null
}
