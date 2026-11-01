import { useCallback, useEffect, useRef } from 'react'

export function useThrottle<T extends (...args: any[]) => void>(
  fn: T,
  delay: number
): T {
  const lastRun = useRef<number | null>(null)

  useEffect(() => {
    lastRun.current = Date.now()
  }, [])

  return useCallback(
    (...args: Parameters<T>) => {
      const now = Date.now()
      const previousRun = lastRun.current
      if (previousRun === null) {
        lastRun.current = now
        if (delay <= 0) fn(...args)
        return
      }

      if (now - previousRun >= delay) {
        fn(...args)
        lastRun.current = now
      }
    },
    [fn, delay]
  ) as T
}
