"use client"

import { useState, useEffect } from "react"
import { Loader2 } from "lucide-react"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Label } from "@/components/ui/label"
import { EmailHtml } from "./email-html"
import { SharedDateTime } from "./shared-date-time"

interface MessageDetail {
  id: string
  from_address?: string
  to_address?: string
  subject: string
  content?: string
  html?: string
  received_at?: number
  sent_at?: number
}

interface SharedMessageDetailProps {
  message: MessageDetail | null
  locale: string
  initialTimeText?: string
  loading?: boolean
  t: {
    messageContent: string
    selectMessage: string
    loading: string
    from: string
    to: string
    subject: string
    time: string
    htmlFormat: string
    textFormat: string
  }
}

type ViewMode = "html" | "text"

export function SharedMessageDetail({
  message,
  locale,
  initialTimeText,
  loading = false,
  t,
}: SharedMessageDetailProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("html")
  const messageId = message?.id
  const messageHtml = message?.html
  const messageContent = message?.content

  // 如果没有HTML内容，默认显示文本
  useEffect(() => {
    if (!messageId) return

    if (!messageHtml && messageContent) {
      setViewMode("text")
    } else if (messageHtml) {
      setViewMode("html")
    }
  }, [messageId, messageHtml, messageContent])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 className="w-5 h-5 animate-spin text-primary/60" />
        <span className="ml-2 text-sm text-muted-foreground">{t.loading}</span>
      </div>
    )
  }

  if (!message) {
    return (
      <div className="flex items-center justify-center h-32 text-muted-foreground">
        {t.selectMessage}
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <div className="p-4 space-y-3 border-b border-border/70 bg-secondary/[0.15]">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-base font-bold flex-1">{message.subject}</h3>
        </div>
        <div className="text-xs text-muted-foreground space-y-1">
          {message.from_address && (
            <p>
              {t.from}: {message.from_address}
            </p>
          )}
          {message.to_address && (
            <p>
              {t.to}: {message.to_address}
            </p>
          )}
          <p>
            {t.time}:{" "}
            <SharedDateTime
              value={message.sent_at || message.received_at || 0}
              locale={locale}
              initialText={initialTimeText}
            />
          </p>
        </div>
      </div>

      {message.html && message.content && (
        <div className="border-b border-border/70 p-2 bg-secondary/[0.15]">
          <RadioGroup
            value={viewMode}
            onValueChange={(value) => setViewMode(value as ViewMode)}
            className="flex items-center gap-4"
          >
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="html" id="html" />
              <Label htmlFor="html" className="text-xs cursor-pointer">
                {t.htmlFormat}
              </Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="text" id="text" />
              <Label htmlFor="text" className="text-xs cursor-pointer">
                {t.textFormat}
              </Label>
            </div>
          </RadioGroup>
        </div>
      )}

      <div className="flex-1 overflow-auto relative">
        {viewMode === "html" && message.html ? (
          <EmailHtml html={message.html} title={message.subject} />
        ) : message.content ? (
          <div className="p-4 text-sm whitespace-pre-wrap">
            {message.content}
          </div>
        ) : (
          <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
            {t.selectMessage}
          </div>
        )}
      </div>
    </div>
  )
}
