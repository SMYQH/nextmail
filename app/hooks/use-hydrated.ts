"use client"

import { useSyncExternalStore } from "react"

const subscribe = () => () => {}

/**
 * Reports whether the client took over the server markup.
 *
 * The server snapshot is false and the client snapshot is true, so the first
 * client render still matches the server output and the component re-renders
 * once the hydration finished. Components that must not appear in the static
 * markup can use it to keep server-rendered state out of the first paint.
 */
export function useHydrated() {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  )
}
