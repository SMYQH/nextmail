"use client"

import { useEffect, useRef } from "react"
import { useTheme } from "next-themes"
import { cn } from "@/lib/utils"

interface TurnstileProps {
  siteKey: string
  onVerify: (token: string) => void
  onExpire?: () => void
  resetSignal?: number
  className?: string
}

/** The widget only understands light and dark, so the app theme is mapped onto it. */
export function turnstileTheme(resolvedTheme: string | undefined): "light" | "dark" {
  return resolvedTheme === "dark" ? "dark" : "light"
}

export function Turnstile({
  siteKey,
  onVerify,
  onExpire,
  resetSignal,
  className,
}: TurnstileProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const widgetIdRef = useRef<string>(null)
  const { resolvedTheme } = useTheme()
  const theme = turnstileTheme(resolvedTheme)

  useEffect(() => {
    if (!siteKey) return

    const renderWidget = () => {
      if (!containerRef.current || !window.turnstile) return

      // The widget cannot change its theme in place, so it is rendered again
      // whenever the application theme changes.
      if (widgetIdRef.current) {
        window.turnstile.remove(widgetIdRef.current)
        widgetIdRef.current = null
      }

      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        theme,
        callback: (token: string) => onVerify(token),
        "error-callback": () => onVerify(""),
        "expired-callback": () => {
          onVerify("")
          onExpire?.()
        },
      })
    }

    const existingScript = document.querySelector<HTMLScriptElement>('script[data-turnstile="true"]')

    if (window.turnstile) {
      renderWidget()
    } else if (existingScript) {
      const handleExistingScriptLoad = () => renderWidget()

      if (existingScript.dataset.loaded === "true") {
        renderWidget()
      } else {
        existingScript.addEventListener("load", handleExistingScriptLoad)
      }

      return () => {
        existingScript.removeEventListener("load", handleExistingScriptLoad)
        if (widgetIdRef.current && window.turnstile) {
          window.turnstile.remove(widgetIdRef.current)
          widgetIdRef.current = null
        }
      }
    } else {
      const script = document.createElement("script")
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
      script.async = true
      script.defer = true
      script.dataset.turnstile = "true"
      const handleScriptLoad = () => {
        script.dataset.loaded = "true"
        renderWidget()
      }
      script.addEventListener("load", handleScriptLoad)
      document.head.appendChild(script)

      return () => {
        script.removeEventListener("load", handleScriptLoad)
        if (widgetIdRef.current && window.turnstile) {
          window.turnstile.remove(widgetIdRef.current)
          widgetIdRef.current = null
        }
      }
    }

    return () => {
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current)
        widgetIdRef.current = null
      }
    }
  }, [siteKey, onExpire, onVerify, theme])

  useEffect(() => {
    if (resetSignal === undefined) return
    if (widgetIdRef.current && window.turnstile) {
      window.turnstile.reset(widgetIdRef.current)
    }
    onVerify("")
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal])

  return (
    <div
      ref={containerRef}
      className={cn("flex justify-center", className)}
    />
  )
}
