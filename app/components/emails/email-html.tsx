"use client"

import { useEffect, useState } from "react"
import DOMPurify from "dompurify"
import { useTheme } from "next-themes"

export function EmailHtml({ html, title }: { html: string; title: string }) {
  const { resolvedTheme } = useTheme()
  const [document, setDocument] = useState<{ html: string; theme: string | undefined; source: string } | null>(null)

  useEffect(() => {
    const clean = DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ["p", "br", "div", "span", "b", "strong", "i", "em", "u", "s", "blockquote", "pre", "code", "ul", "ol", "li", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "a"],
      ALLOWED_ATTR: ["href", "title", "colspan", "rowspan", "dir", "lang"],
      ALLOWED_URI_REGEXP: /^https:\/\//i,
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      RETURN_DOM_FRAGMENT: true,
    })
    clean.querySelectorAll("a").forEach(link => {
      link.setAttribute("target", "_blank")
      link.setAttribute("rel", "noopener noreferrer")
    })
    const container = window.document.createElement("div")
    container.appendChild(clean)
    setDocument({ html, theme: resolvedTheme, source: `<!doctype html><html><head>
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
      <meta name="referrer" content="no-referrer">
      <style>body{margin:0;padding:20px;font-family:system-ui,sans-serif;overflow-wrap:anywhere;color:${resolvedTheme === "dark" ? "#fff" : "#000"};background:${resolvedTheme === "dark" ? "#1a1a1a" : "#fff"}}table{max-width:100%}pre{white-space:pre-wrap}a{color:#2563eb}</style>
      </head><body>${container.innerHTML}</body></html>` })
  }, [html, resolvedTheme])

  // Mount only the sanitized document, replacing the frame when its content or
  // theme changes instead of navigating an initially blank frame.
  if (!document || document.html !== html || document.theme !== resolvedTheme) return null

  return <iframe key={document.source} title={title} srcDoc={document.source}
    className="absolute inset-0 w-full h-full border-0"
    sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" />
}
