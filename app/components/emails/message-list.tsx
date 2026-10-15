"use client"

import { useState, useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import {Mail, Calendar, RefreshCw, Trash2, Share2} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { useThrottle } from "@/hooks/use-throttle"
import { EMAIL_CONFIG } from "@/config"
import { useToast } from "@/components/ui/use-toast"
import { ShareMessageDialog } from "./share-message-dialog"
import { LatestRequestGate } from "@/lib/latest-request-gate"
import { mergeRefreshedMessages } from "@/lib/message-list-refresh"
import { MAILBOX_UPDATE_EVENT, mailboxSnapshots, notifyMailboxUpdate, type MailboxUpdate } from "@/lib/mailbox-events"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";

interface Message {
  id: string
  from_address?: string
  to_address?: string
  subject: string
  received_at?: number
  sent_at?: number
  content?: string
  html?: string
  is_read?: boolean
}

interface MessageListProps {
  email: {
    id: string
    address: string
  }
  messageType: 'received' | 'sent'
  onMessageSelect: (messageId: string | null, messageType?: 'received' | 'sent', wasUnread?: boolean) => void
  selectedMessageId?: string | null
  refreshTrigger?: number
}

interface MessageResponse {
  messages: Message[]
  nextCursor: string | null
  total?: number
  latestCursor: string
  hasMore?: boolean
  unread?: number
}

export function MessageList({ email, messageType, onMessageSelect, selectedMessageId, refreshTrigger }: MessageListProps) {
  const t = useTranslations("emails.messages")
  const tList = useTranslations("emails.list")
  const tCommon = useTranslations("common.actions")
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const nextCursorRef = useRef<string | null>(null)
  const pollTimeoutRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const messagesRef = useRef<Message[]>([]) // 添加 ref 来追踪最新的消息列表
  const latestCursorRef = useRef<string | null>(null)
  const requestGateRef = useRef(new LatestRequestGate())
  const activeRequestRef = useRef<AbortController | null>(null)
  const [total, setTotal] = useState(0)
  const [messageToDelete, setMessageToDelete] = useState<Message | null>(null)
  const { toast } = useToast()

  // 当 messages 改变时更新 ref
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  type FetchKind = "initial" | "poll" | "refresh" | "more"

  const replaceMessages = (nextMessages: Message[]) => {
    messagesRef.current = nextMessages
    setMessages(nextMessages)
  }

  const replaceNextCursor = (cursor: string | null) => {
    nextCursorRef.current = cursor
    setNextCursor(cursor)
  }

  const mergeIncomingMessages = (incoming: Message[]) => {
    const merged = [...new Map([...messagesRef.current, ...incoming].map(message => [message.id, message])).values()]
    // Arrival order can differ from display order when deliveries finish out of order.
    return merged.sort((a, b) => (
      (messageType === 'sent' ? b.sent_at : b.received_at) || 0
    ) - ((messageType === 'sent' ? a.sent_at : a.received_at) || 0) || b.id.localeCompare(a.id))
  }

  const fetchMessages = async (cursor?: string, kind: FetchKind = cursor ? "more" : "poll") => {
    if (kind === "poll" && (activeRequestRef.current || document.visibilityState === "hidden")) return

    const scope = `mailbox:${email.id}:${messageType}`
    const ticket = requestGateRef.current.begin(scope)
    const snapshot = mailboxSnapshots.snapshot()
    const isSnapshotCurrent = () => messageType === 'sent' || mailboxSnapshots.isCurrent(email.id, snapshot)
    const reconcileCounts = (data: MessageResponse) => {
      if (messageType !== 'sent' && data.total !== undefined && data.unread !== undefined) {
        Object.assign(data, mailboxSnapshots.reconcile(email.id, snapshot, { total: data.total, unread: data.unread }))
      }
    }
    activeRequestRef.current?.abort()
    const controller = new AbortController()
    activeRequestRef.current = controller

    if (kind === "initial") setLoading(true)
    if (kind === "refresh") {
      setRefreshing(true)
      setLoadingMore(false)
    }
    if (kind === "more") {
      setLoadingMore(true)
      setRefreshing(false)
    }

    try {
      const url = new URL(`/api/emails/${email.id}`, window.location.origin)
      if (messageType === 'sent') {
        url.searchParams.set('type', 'sent')
      }
      if (cursor) {
        url.searchParams.set('cursor', cursor)
      }
      const incremental = kind === "poll" && latestCursorRef.current
      if (incremental) url.searchParams.set('since', incremental)
      if (incremental) {
        let hasMore = true
        while (hasMore && ticket.isCurrent()) {
          const response = await fetch(url, { signal: controller.signal })
          if (!response.ok) return
          const data = await response.json() as MessageResponse
          if (!ticket.isCurrent() || !isSnapshotCurrent()) return
          reconcileCounts(data)
          replaceMessages(mergeIncomingMessages(data.messages))
          // The mailbox list may already include these arrivals in its aggregate snapshot.
          if (typeof data.total === "number") setTotal(data.total)
          if (messageType !== 'sent' && data.total !== undefined && data.unread !== undefined) notifyMailboxUpdate({
            emailId: email.id, totalDelta: 0, unreadDelta: 0,
            total: data.total, unread: data.unread,
          })
          latestCursorRef.current = data.latestCursor
          hasMore = Boolean(data.hasMore)
          url.searchParams.set('since', data.latestCursor)
        }
        return
      }
      const response = await fetch(url, { signal: controller.signal })
      if (!response.ok) return
      const data = await response.json() as MessageResponse
      if (!ticket.isCurrent() || !isSnapshotCurrent()) return
      reconcileCounts(data)

      if (!cursor) {
        // A head refresh does not include late arrivals that sort into the loaded tail.
        if (!latestCursorRef.current) latestCursorRef.current = data.latestCursor
        if (messageType !== 'sent' && data.unread !== undefined) notifyMailboxUpdate({
          emailId: email.id, totalDelta: 0, unreadDelta: 0, total: data.total, unread: data.unread,
        })
        const result = mergeRefreshedMessages(
          data.messages,
          messagesRef.current,
          data.nextCursor,
          nextCursorRef.current,
        )
        replaceMessages(result.messages)
        replaceNextCursor(result.nextCursor)
        if (typeof data.total === "number") setTotal(data.total)
        return
      }
      replaceMessages(mergeIncomingMessages(data.messages))
      replaceNextCursor(data.nextCursor)
      if (typeof data.total === "number") setTotal(data.total)
    } catch (error) {
      if (!controller.signal.aborted && ticket.isCurrent()) {
        console.error("Failed to fetch messages:", error)
      }
    } finally {
      if (ticket.isCurrent()) {
        activeRequestRef.current = null
        setLoading(false)
        setRefreshing(false)
        setLoadingMore(false)
      }
    }
  }

  const startPolling = () => {
    stopPolling()
    pollTimeoutRef.current = setInterval(() => {
      void fetchMessages(undefined, "poll")
    }, EMAIL_CONFIG.POLL_INTERVAL)
  }

  const stopPolling = () => {
    if (pollTimeoutRef.current) {
      clearInterval(pollTimeoutRef.current)
      pollTimeoutRef.current = null
    }
  }

  const handleRefresh = async () => {
    await fetchMessages(undefined, "refresh")
  }

  const handleScroll = useThrottle((e: React.UIEvent<HTMLDivElement>) => {
    if (loadingMore) return

    const { scrollHeight, scrollTop, clientHeight } = e.currentTarget
    const threshold = clientHeight * 1.5
    const remainingScroll = scrollHeight - scrollTop

    if (remainingScroll <= threshold && nextCursor) {
      void fetchMessages(nextCursor, "more")
    }
  }, 200)

  const handleDelete = async (message: Message) => {
    const snapshot = mailboxSnapshots.snapshot()
    try {
      const response = await fetch(`/api/emails/${email.id}/${message.id}${messageType === 'sent' ? '?type=sent' : ''}`, {
        method: "DELETE"
      })

      if (!response.ok) {
        const data = await response.json()
        toast({
          title: t("deleteFailed"),
          description: (data as { error: string }).error,
          variant: "destructive"
        })
        return
      }

      const data = await response.json() as { total?: number; unread?: number }
      replaceMessages(messagesRef.current.filter(e => e.id !== message.id))
      if (messageType === 'sent') {
        setTotal(prev => Math.max(0, prev - 1))
      } else if (typeof data.total === "number" && typeof data.unread === "number") {
        setTotal(data.total)
        notifyMailboxUpdate({
          emailId: email.id, messageId: message.id, deleted: true,
          totalDelta: 0, unreadDelta: 0, total: data.total, unread: data.unread,
        }, snapshot)
      }

      toast({
        title: tList("success"),
        description: t("deleteSuccess")
      })

      if (selectedMessageId === message.id) {
        onMessageSelect(null)
      }
    } catch {
      toast({
        title: tList("error"),
        description: t("deleteFailed"),
        variant: "destructive"
      })
    } finally {
      setMessageToDelete(null)
    }
  }

  useEffect(() => {
    if (!email.id) {
      return
    }
    const requestGate = requestGateRef.current
    requestGate.invalidate()
    activeRequestRef.current?.abort()
    activeRequestRef.current = null
    setMessages([])
    messagesRef.current = []
    latestCursorRef.current = null
    setTotal(0)
    setLoading(true)
    replaceNextCursor(null)
    void fetchMessages(undefined, "initial")
    startPolling() 

    return () => {
      stopPolling() 
      requestGate.invalidate()
      activeRequestRef.current?.abort()
      activeRequestRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email.id, messageType])

  useEffect(() => {
    if (refreshTrigger && refreshTrigger > 0) {
      void fetchMessages(undefined, "refresh")
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTrigger])

  useEffect(() => {
    const update = (event: Event) => {
      const detail = (event as CustomEvent<MailboxUpdate>).detail
      if (detail.emailId !== email.id || messageType === 'sent') return
      if (typeof detail.total === "number") setTotal(detail.total)
      if (!detail.read && !detail.deleted) return
      replaceMessages(detail.deleted
        ? messagesRef.current.filter(message => message.id !== detail.messageId)
        : messagesRef.current.map(message => message.id === detail.messageId ? { ...message, is_read: true } : message))
    }
    window.addEventListener(MAILBOX_UPDATE_EVENT, update)
    return () => window.removeEventListener(MAILBOX_UPDATE_EVENT, update)
  }, [email.id, messageType])

  return (
  <>
    <div className="h-full flex flex-col">
      <div className="p-2.5 flex justify-between items-center border-b border-border/70 bg-secondary/20">
        <Button
          variant="ghost"
          size="icon"
          aria-label={tCommon("refresh")}
          onClick={handleRefresh}
          disabled={refreshing}
          className="h-8 w-8"
              aria-busy={refreshing}
        >
          <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
        </Button>
        <span className="text-xs text-muted-foreground">
          {total > 0 ? `${total} ${t("messageCount")}` : t("noMessages")}
        </span>
      </div>

      <div className="flex-1 overflow-auto" onScroll={handleScroll}>
        {loading ? (
          <div className="p-4 text-center text-sm text-muted-foreground">{t("loading")}</div>
        ) : messages.length > 0 ? (
          <div className="divide-y divide-border/60">
            {messages.map(message => (
              <div
                key={message.id}
                className={cn(
                  "fluent-list-item p-3 cursor-pointer group",
                  selectedMessageId === message.id && "is-selected"
                )}
              >
                <div className="flex items-start gap-3">
                  <button type="button" onClick={() => onMessageSelect(message.id, messageType, messageType !== 'sent' && !message.is_read)}
                    aria-pressed={selectedMessageId === message.id}
                    className="flex flex-1 min-w-0 items-start gap-3 text-left rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
                  <Mail className="w-4 h-4 shrink-0 text-primary/60 mt-1" />
                  <div className="min-w-0 flex-1">
                    <p className={cn("text-sm truncate", messageType !== 'sent' && !message.is_read ? "font-bold" : "font-normal")}>{message.subject}</p>
                    <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="truncate">
                        {message.from_address || message.to_address || ''}
                      </span>
                      <span className="flex items-center gap-1">
                        <Calendar className="w-3 h-3" />
                        {new Date(message.received_at || message.sent_at || 0).toLocaleString()}
                      </span>
                    </div>
                  </div>
                  </button>
                  <div className="flex shrink-0 gap-1" onClick={(e) => e.stopPropagation()}>
                    <ShareMessageDialog
                      emailId={email.id}
                      messageId={message.id}
                      messageSubject={message.subject}
                      trigger={
                        <Button
                          aria-label={tCommon("share")}
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                        >
                          <Share2 className="h-4 w-4" />
                        </Button>
                      }
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      aria-label={tCommon("delete")}
                      onClick={(e) => {
                        e.stopPropagation()
                        setMessageToDelete(message)
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
            {loadingMore && (
              <div className="text-center text-sm text-muted-foreground py-2">
                {t("loadingMore")}
              </div>
            )}
          </div>
        ) : (
          <div className="p-4 text-center text-sm text-muted-foreground">
            {t("noMessages")}
          </div>
        )}
      </div>
    </div>
    <AlertDialog open={!!messageToDelete} onOpenChange={() => setMessageToDelete(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("deleteConfirm")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("deleteDescription", { subject: messageToDelete?.subject || "" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
          <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={() => messageToDelete && handleDelete(messageToDelete)}
          >
            {tCommon("delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>
  )
}
