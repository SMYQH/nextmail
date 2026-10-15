"use client"

import { useState, useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { Loader2, Share2 } from "lucide-react"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Label } from "@/components/ui/label"
import { EmailHtml } from "./email-html"
import { useToast } from "@/components/ui/use-toast"
import { ShareMessageDialog } from "./share-message-dialog"
import { mailboxSnapshots, notifyMailboxUpdate } from "@/lib/mailbox-events"

interface Message {
  id: string
  from_address?: string
  to_address?: string
  subject: string
  content: string
  html?: string
  received_at?: number
  sent_at?: number
}

interface MessageViewProps {
  emailId: string
  messageId: string
  messageType?: 'received' | 'sent'
  wasUnread?: boolean
  onRead?: () => void
  onClose: () => void
}

type ViewMode = "html" | "text"

export function MessageView({ emailId, messageId, messageType = 'received', onRead }: MessageViewProps) {
  const t = useTranslations("emails.messageView")
  const tList = useTranslations("emails.list")
  const [message, setMessage] = useState<Message | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>("html")
  const { toast } = useToast()
  const notifiedRead = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    const snapshot = mailboxSnapshots.snapshot()
    const fetchMessage = async () => {
      try {
        setLoading(true)
        setError(null)
        setMessage(null)
        
        const url = `/api/emails/${emailId}/${messageId}${messageType === 'sent' ? '?type=sent' : ''}`;
        
        const response = await fetch(url, { signal: controller.signal })
        
        if (!response.ok) {
          const errorData = await response.json()
          if (controller.signal.aborted) return
          const errorMessage = (errorData as { error?: string }).error || t("loadError")
          setError(errorMessage)
          toast({
            title: tList("error"),
            description: errorMessage,
            variant: "destructive"
          })
          return
        }
        
        const data = await response.json() as { message: Message; total?: number; unread?: number }
        if (controller.signal.aborted) return
        setMessage(data.message)
        if (messageType !== 'sent' && !notifiedRead.current) {
          notifiedRead.current = true
          notifyMailboxUpdate({
            emailId, messageId, totalDelta: 0, unreadDelta: 0, read: true,
            total: data.total, unread: data.unread,
          }, snapshot)
          onRead?.()
        }
        setViewMode(data.message.html ? "html" : "text")
      } catch (error) {
        if (controller.signal.aborted) return
        const errorMessage = t("networkError")
        setError(errorMessage)
        toast({
          title: tList("error"), 
          description: errorMessage,
          variant: "destructive"
        })
        console.error("Failed to fetch message:", error)
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }

    fetchMessage()
    return () => controller.abort()
  }, [emailId, messageId, messageType, onRead, toast, t, tList])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 className="w-5 h-5 animate-spin text-primary/60" />
        <span className="ml-2 text-sm text-muted-foreground">{t("loading")}</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-32 text-center">
        <p className="text-sm text-destructive mb-2">{error}</p>
        <button 
          onClick={() => window.location.reload()} 
          className="text-xs text-primary hover:underline"
        >
          {t("retry")}
        </button>
      </div>
    )
  }

  if (!message) return null

  return (
    <div className="h-full flex flex-col">
      <div className="p-4 space-y-3 border-b border-border/70 bg-secondary/[0.15]">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-base font-bold flex-1">{message.subject}</h3>
          <ShareMessageDialog 
            emailId={emailId}
            messageId={message.id} 
            messageSubject={message.subject}
            trigger={
              <button aria-label={t("share")} className="p-1.5 hover:bg-accent rounded-md transition-colors">
                <Share2 className="h-4 w-4 text-muted-foreground" />
              </button>
            }
          />
        </div>
        <div className="text-xs text-muted-foreground space-y-1">
          {message.from_address && (
            <p>{t("from")}: {message.from_address}</p>
          )}
          {message.to_address && (
            <p>{t("to")}: {message.to_address}</p>
          )}
          <p>{t("time")}: {new Date(message.sent_at || message.received_at || 0).toLocaleString()}</p>
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
              <Label 
                htmlFor="html" 
                className="text-xs cursor-pointer"
              >
                {t("htmlFormat")}
              </Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="text" id="text" />
              <Label 
                htmlFor="text" 
                className="text-xs cursor-pointer"
              >
                {t("textFormat")}
              </Label>
            </div>
          </RadioGroup>
        </div>
      )}
      
      <div className="flex-1 overflow-auto relative">
        {viewMode === "html" && message.html ? (
          <EmailHtml html={message.html} title={message.subject} />
        ) : (
          <div className="p-4 text-sm whitespace-pre-wrap">
            {message.content}
          </div>
        )}
      </div>
    </div>
  )
}
