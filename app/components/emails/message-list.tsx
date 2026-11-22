"use client"

import { useState, useEffect, useEffectEvent, useRef } from "react"
import { useLocale, useTranslations } from "next-intl"
import { SharedDateTime } from "./shared-date-time"
import { EmptyState } from "@/components/ui/empty-state"
import { Calendar, RefreshCw, Trash2, Share2, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { useThrottle } from "@/hooks/use-throttle"
import { EMAIL_CONFIG } from "@/config"
import { useToast } from "@/components/ui/use-toast"
import { ShareMessageDialog } from "./share-message-dialog"
import { LatestRequestGate } from "@/lib/latest-request-gate"
import { mergeRefreshedMessages } from "@/lib/message-list-refresh"
import { MAX_BULK_DELETE_IDS } from "@/lib/bulk-delete-ids"
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

/** Where the keyboard focus goes after the deleted row left the list. */
type MessageFocusTarget = { kind: "message"; id: string } | { kind: "refresh" }

type DeleteTarget = { kind: "single"; message: Message } | { kind: "bulk"; ids: string[] }

interface MessageResponse {
  messages: Message[]
  nextCursor: string | null
  total?: number
  latestCursor: string
  hasMore?: boolean
  unread?: number
}

async function requestMessagePage(
  emailId: string,
  messageType: "received" | "sent",
  signal: AbortSignal,
  cursor?: string,
  since?: string,
): Promise<MessageResponse | null> {
  const url = new URL(`/api/emails/${emailId}`, window.location.origin)
  if (messageType === "sent") url.searchParams.set("type", "sent")
  if (cursor) url.searchParams.set("cursor", cursor)
  if (since) url.searchParams.set("since", since)

  const response = await fetch(url, { signal })
  if (!response.ok) return null
  return await response.json() as MessageResponse
}

export function MessageList(props: MessageListProps) {
  const mailboxKey = JSON.stringify([props.email.id, props.messageType])
  return <MessageListSession key={mailboxKey} {...props} />
}

function MessageListSession({ email, messageType, onMessageSelect, selectedMessageId, refreshTrigger }: MessageListProps) {
  const locale = useLocale()
  const t = useTranslations("emails.messages")
  const tList = useTranslations("emails.list")
  const tCommon = useTranslations("common.actions")
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [manualRefreshing, setManualRefreshing] = useState(false)
  const [completedRefreshTrigger, setCompletedRefreshTrigger] = useState(0)
  const latestRefreshTriggerRef = useRef(refreshTrigger)
  const refreshing = manualRefreshing || Boolean(
    refreshTrigger && refreshTrigger > 0 && refreshTrigger !== completedRefreshTrigger,
  )
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const nextCursorRef = useRef<string | null>(null)
  const pollTimeoutRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const messagesRef = useRef<Message[]>([]) // 添加 ref 来追踪最新的消息列表
  const latestCursorRef = useRef<string | null>(null)
  const requestGateRef = useRef(new LatestRequestGate())
  const activeRequestRef = useRef<AbortController | null>(null)
  const [total, setTotal] = useState(0)
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set())
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteError, setDeleteError] = useState("")
  const [deleting, setDeleting] = useState(false)
  const deleteInFlightRef = useRef(false)
  const mountedRef = useRef(false)
  const deleteButtonRef = useRef<HTMLButtonElement | null>(null)
  const messageButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const refreshButtonRef = useRef<HTMLButtonElement>(null)
  const restoreFocusRef = useRef<MessageFocusTarget | null>(null)
  const { toast } = useToast()

  // 当 messages 改变时更新 ref
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  type FetchKind = "poll" | "refresh" | "more"

  const replaceMessages = (nextMessages: Message[]) => {
    messagesRef.current = nextMessages
    setMessages(nextMessages)
    setCheckedIds(current => {
      if (current.size === 0) return current
      const remaining = new Set(nextMessages.filter(message => current.has(message.id)).map(message => message.id))
      return remaining.size === current.size ? current : remaining
    })
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

  const fetchMessages = async (
    cursor?: string,
    kind: FetchKind = cursor ? "more" : "poll",
  ) => {
    if (kind === "poll" && (deleteInFlightRef.current || activeRequestRef.current || document.visibilityState === "hidden")) return

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

    try {
      const incremental = kind === "poll" && latestCursorRef.current
      if (incremental) {
        let since = incremental
        let hasMore = true
        while (hasMore && ticket.isCurrent()) {
          const data = await requestMessagePage(email.id, messageType, controller.signal, undefined, since)
          if (!data) return
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
          since = data.latestCursor
          hasMore = Boolean(data.hasMore)
        }
        return
      }
      const data = await requestMessagePage(email.id, messageType, controller.signal, cursor)
      if (!data) return
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
        setLoadingMore(false)
      }
    }
  }

  const pollMessages = useEffectEvent(() => {
    void fetchMessages(undefined, "poll")
  })

  const handleRefresh = async () => {
    setManualRefreshing(true)
    setLoadingMore(false)
    try {
      await fetchMessages(undefined, "refresh")
    } finally {
      setManualRefreshing(false)
    }
  }

  const handleScroll = useThrottle((e: React.UIEvent<HTMLDivElement>) => {
    if (loadingMore || refreshing || deleteInFlightRef.current) return

    const { scrollHeight, scrollTop, clientHeight } = e.currentTarget
    const threshold = clientHeight * 1.5
    const remainingScroll = scrollHeight - scrollTop

    if (remainingScroll <= threshold && nextCursor) {
      setLoadingMore(true)
      void fetchMessages(nextCursor, "more")
    }
  }, 200)

  const toggleMessage = (id: string, checked: boolean) => {
    setCheckedIds(current => {
      if (checked && current.size >= MAX_BULK_DELETE_IDS) return current
      const next = new Set(current)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const openDeleteDialog = (target: DeleteTarget, button: HTMLButtonElement) => {
    deleteButtonRef.current = button
    setDeleteTarget(target)
    setDeleteError("")
    setDeleteOpen(true)
  }

  const handleDelete = async (target: DeleteTarget) => {
    if (deleteInFlightRef.current) return
    deleteInFlightRef.current = true
    setDeleting(true)
    setDeleteError("")

    const bulk = target.kind === "bulk"
    const ids = bulk ? target.ids : [target.message.id]
    const resource = bulk ? "messages/bulk" : encodeURIComponent(target.message.id)
    const typeQuery = messageType === "sent" ? "?type=sent" : ""
    const snapshot = mailboxSnapshots.snapshot()
    try {
      const response = await fetch(`/api/emails/${encodeURIComponent(email.id)}/${resource}${typeQuery}`, {
        method: "DELETE",
        ...(bulk ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) } : {}),
      })

      const data = await response.json() as {
        error?: string
        success?: boolean
        deletedIds?: unknown
        unavailableIds?: unknown
        total?: number
        unread?: number
      }
      const { unavailableIds } = data
      const staleIds = bulk && response.status === 403 && Array.isArray(unavailableIds)
        ? ids.filter(id => unavailableIds.includes(id))
        : []
      const selectionChanged = staleIds.length > 0

      if (!response.ok && !selectionChanged) {
        if (bulk) {
          setDeleteError(t(response.status === 403 ? "bulkDeleteUnavailable" : "bulkDeleteFailed"))
        } else {
          toast({ title: t("deleteFailed"), description: data.error, variant: "destructive" })
        }
        return
      }

      if (bulk && response.ok) {
        const { deletedIds } = data
        if (data.success !== true || !Array.isArray(deletedIds) || deletedIds.length !== ids.length ||
            !ids.every(id => deletedIds.includes(id)) || typeof data.total !== "number" ||
            (messageType === "received" && typeof data.unread !== "number")) {
          throw new Error("Invalid bulk message deletion response")
        }
      }

      const deletedMessageIds = new Set(selectionChanged ? staleIds : ids)
      const refreshAfterDelete = mountedRef.current && Boolean(selectionChanged || activeRequestRef.current || nextCursorRef.current)
      if (mountedRef.current) {
        requestGateRef.current.invalidate()
        activeRequestRef.current?.abort()
        activeRequestRef.current = null
        setLoadingMore(false)
        setCompletedRefreshTrigger(latestRefreshTriggerRef.current ?? 0)

        const current = messagesRef.current
        const deletedIndex = current.findIndex(message => deletedMessageIds.has(message.id))
        const remaining = current.filter(message => !deletedMessageIds.has(message.id))
        // The deleted row takes its controls with it, so the dialog can no longer
        // restore the focus to the delete button. Remember the neighbour that
        // takes the place of the removed row.
        const neighbour = remaining[deletedIndex] ?? remaining[deletedIndex - 1]
        if (!selectionChanged || staleIds.length === ids.length) {
          restoreFocusRef.current = neighbour ? { kind: "message", id: neighbour.id } : { kind: "refresh" }
        }
        replaceMessages(remaining)
        if (refreshAfterDelete && remaining.length === 0) setLoading(true)
        if (messageType === "sent" && response.ok) setTotal(prev => data.total ?? Math.max(0, prev - ids.length))
        if (selectedMessageId && deletedMessageIds.has(selectedMessageId)) onMessageSelect(null)
        setDeleteOpen(false)
      }

      if (messageType === "received" && (selectionChanged || (typeof data.total === "number" && typeof data.unread === "number"))) {
        notifyMailboxUpdate({
          emailId: email.id, deleted: true, deletedMessageIds,
          totalDelta: 0, unreadDelta: 0, total: data.total, unread: data.unread,
        }, snapshot)
      }

      if (refreshAfterDelete) void fetchMessages(undefined, "refresh")

      toast({
        title: tList(selectionChanged ? "error" : "success"),
        description: selectionChanged ? t("bulkDeleteSelectionChanged") : bulk ? t("bulkDeleteSuccess", { count: ids.length }) : t("deleteSuccess"),
        variant: selectionChanged ? "destructive" : undefined,
      })
    } catch {
      if (bulk) setDeleteError(t("bulkDeleteFailed"))
      else toast({ title: tList("error"), description: t("deleteFailed"), variant: "destructive" })
    } finally {
      deleteInFlightRef.current = false
      setDeleting(false)
      if (!bulk) setDeleteOpen(false)
    }
  }

  useEffect(() => {
    if (!email.id) return
    mountedRef.current = true
    const scope = `mailbox:${email.id}:${messageType}`
    const requestGate = requestGateRef.current
    const ticket = requestGate.begin(scope)
    const snapshot = mailboxSnapshots.snapshot()
    activeRequestRef.current?.abort()
    const controller = new AbortController()
    activeRequestRef.current = controller
    latestCursorRef.current = null

    void requestMessagePage(email.id, messageType, controller.signal)
      .then(data => {
        if (!data || !ticket.isCurrent() || (messageType !== "sent" && !mailboxSnapshots.isCurrent(email.id, snapshot))) return
        if (messageType !== "sent" && data.total !== undefined && data.unread !== undefined) {
          Object.assign(data, mailboxSnapshots.reconcile(email.id, snapshot, { total: data.total, unread: data.unread }))
        }
        if (!latestCursorRef.current) latestCursorRef.current = data.latestCursor
        if (messageType !== "sent" && data.unread !== undefined) notifyMailboxUpdate({
          emailId: email.id, totalDelta: 0, unreadDelta: 0, total: data.total, unread: data.unread,
        })
        const result = mergeRefreshedMessages(data.messages, messagesRef.current, data.nextCursor, nextCursorRef.current)
        replaceMessages(result.messages)
        replaceNextCursor(result.nextCursor)
        if (typeof data.total === "number") setTotal(data.total)
      })
      .catch(error => {
        if (!controller.signal.aborted && ticket.isCurrent()) console.error("Failed to fetch messages:", error)
      })
      .finally(() => {
        if (ticket.isCurrent()) {
          activeRequestRef.current = null
          setLoading(false)
          setLoadingMore(false)
        }
      })

    const interval = setInterval(() => {
      pollMessages()
    }, EMAIL_CONFIG.POLL_INTERVAL)
    pollTimeoutRef.current = interval

    return () => {
      mountedRef.current = false
      clearInterval(interval)
      if (pollTimeoutRef.current === interval) pollTimeoutRef.current = null
      requestGate.invalidate()
      activeRequestRef.current?.abort()
      activeRequestRef.current = null
    }
  }, [email.id, messageType])

  useEffect(() => {
    latestRefreshTriggerRef.current = refreshTrigger
    if (!email.id || !refreshTrigger || refreshTrigger <= 0) return

    const scope = `mailbox:${email.id}:${messageType}`
    const requestGate = requestGateRef.current
    const ticket = requestGate.begin(scope)
    activeRequestRef.current?.abort()
    const controller = new AbortController()
    activeRequestRef.current = controller
    const snapshot = mailboxSnapshots.snapshot()

    void requestMessagePage(email.id, messageType, controller.signal)
      .then(data => {
        if (!data || !ticket.isCurrent() || (messageType !== "sent" && !mailboxSnapshots.isCurrent(email.id, snapshot))) return
        if (messageType !== "sent" && data.total !== undefined && data.unread !== undefined) {
          Object.assign(data, mailboxSnapshots.reconcile(email.id, snapshot, { total: data.total, unread: data.unread }))
        }
        if (!latestCursorRef.current) latestCursorRef.current = data.latestCursor
        if (messageType !== "sent" && data.unread !== undefined) notifyMailboxUpdate({
          emailId: email.id, totalDelta: 0, unreadDelta: 0, total: data.total, unread: data.unread,
        })
        const result = mergeRefreshedMessages(data.messages, messagesRef.current, data.nextCursor, nextCursorRef.current)
        replaceMessages(result.messages)
        replaceNextCursor(result.nextCursor)
        if (typeof data.total === "number") setTotal(data.total)
      })
      .catch(error => {
        if (!controller.signal.aborted && ticket.isCurrent()) console.error("Failed to fetch messages:", error)
      })
      .finally(() => {
        if (ticket.isCurrent()) {
          activeRequestRef.current = null
          setLoading(false)
          setLoadingMore(false)
          if (latestRefreshTriggerRef.current === refreshTrigger) {
            setCompletedRefreshTrigger(refreshTrigger)
          }
        }
      })

    return () => {
      requestGate.invalidate()
      controller.abort()
      if (activeRequestRef.current === controller) activeRequestRef.current = null
    }
  }, [email.id, messageType, refreshTrigger])

  // The deleted row takes the focused control with it, so the focus would end
  // up on the document body. Restore it to a row that is still listed.
  const focusDeletedNeighbour = (target: MessageFocusTarget) => {
    if (target.kind === "message") {
      const button = messageButtonRefs.current.get(target.id)
      if (button) {
        button.focus()
        return
      }
    }
    refreshButtonRef.current?.focus()
  }

  useEffect(() => {
    const update = (event: Event) => {
      const detail = (event as CustomEvent<MailboxUpdate>).detail
      if (detail.emailId !== email.id || messageType === 'sent') return
      if (typeof detail.total === "number") setTotal(detail.total)
      if (!detail.read && !detail.deleted) return
      replaceMessages(detail.deleted
        ? messagesRef.current.filter(message => message.id !== detail.messageId && !detail.deletedMessageIds?.has(message.id))
        : messagesRef.current.map(message => message.id === detail.messageId ? { ...message, is_read: true } : message))
    }
    window.addEventListener(MAILBOX_UPDATE_EVENT, update)
    return () => window.removeEventListener(MAILBOX_UPDATE_EVENT, update)
  }, [email.id, messageType])

  const selectedCount = checkedIds.size
  const atSelectionLimit = selectedCount === MAX_BULK_DELETE_IDS
  const bulkTarget = deleteTarget?.kind === "bulk" ? deleteTarget : null

  return (
  <>
    <div className="h-full flex flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/70 bg-secondary/20 p-2.5">
        <Button
          ref={refreshButtonRef}
          variant="ghost"
          size="icon"
          aria-label={tCommon("refresh")}
          onClick={handleRefresh}
          disabled={refreshing || deleting}
          className="size-8 shrink-0"
          aria-busy={refreshing}
        >
          <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
        </Button>
        <span role="status" className={cn("min-w-0 flex-1 px-1 text-xs text-muted-foreground", selectedCount === 0 && "text-right")}>
          {selectedCount > 0
            ? (atSelectionLimit ? t("maxSelected", { count: selectedCount }) : t("selectedCount", { count: selectedCount }))
            : (total > 0 ? `${total} ${t("messageCount")}` : t("noMessages"))}
        </span>
        {selectedCount > 0 && (
          <>
            <Button
              variant="destructive"
              size="sm"
              className="h-8 shrink-0 gap-1.5 px-2"
              disabled={deleting}
              onClick={event => openDeleteDialog({ kind: "bulk", ids: [...checkedIds] }, event.currentTarget)}
            >
              <Trash2 aria-hidden="true" className="size-4" />
              {t("deleteSelected")}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-label={tList("clearSelection")}
              title={tList("clearSelection")}
              disabled={deleting}
              onClick={() => {
                refreshButtonRef.current?.focus()
                setCheckedIds(new Set())
              }}
            >
              <X aria-hidden="true" className="size-4" />
            </Button>
          </>
        )}
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
                <div className="flex items-start gap-1.5">
                  <Checkbox
                    compact
                    aria-label={t("selectMessage", { subject: message.subject })}
                    checked={checkedIds.has(message.id)}
                    disabled={deleting || (atSelectionLimit && !checkedIds.has(message.id))}
                    onChange={checked => toggleMessage(message.id, checked)}
                  />
                  <button type="button" onClick={() => onMessageSelect(message.id, messageType, messageType !== 'sent' && !message.is_read)}
                    ref={(element) => {
                      if (element) messageButtonRefs.current.set(message.id, element)
                      else messageButtonRefs.current.delete(message.id)
                    }}
                    aria-pressed={selectedMessageId === message.id}
                    className="flex flex-1 min-w-0 items-start text-left rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
                  <div className="min-w-0 flex-1">
                    <p title={message.subject} className={cn("text-sm truncate", messageType !== 'sent' && !message.is_read ? "font-bold" : "font-normal")}>{message.subject}</p>
                    <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="truncate" title={message.from_address || message.to_address || ''}>
                        {message.from_address || message.to_address || ''}
                      </span>
                      <span className="flex items-center gap-1">
                        <Calendar className="w-3 h-3" />
                        <SharedDateTime value={message.received_at || message.sent_at || 0} locale={locale} />
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
                      disabled={deleting}
                      onClick={(e) => {
                        e.stopPropagation()
                        openDeleteDialog({ kind: "single", message }, e.currentTarget)
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
          <EmptyState message={t("noMessages")} />
        )}
      </div>
    </div>
    <AlertDialog open={deleteOpen} onOpenChange={open => {
      if (!open && !deleteInFlightRef.current) setDeleteOpen(false)
    }}>
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          // The confirmation dialog can still hold the focus; it restores the focus
          // when it closes.
          const target = restoreFocusRef.current
          const button = deleteButtonRef.current
          deleteButtonRef.current = null
          if (!target) {
            event.preventDefault()
            if (button?.isConnected) button.focus()
            else refreshButtonRef.current?.focus()
            return
          }
          restoreFocusRef.current = null
          // The default restore targets the delete button of the removed row,
          // which would drop the focus on the document body.
          event.preventDefault()
          focusDeletedNeighbour(target)
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{t(bulkTarget ? "bulkDeleteConfirm" : "deleteConfirm")}</AlertDialogTitle>
          <AlertDialogDescription>
            {bulkTarget
              ? t("bulkDeleteDescription", { count: bulkTarget.ids.length })
              : t("deleteDescription", { subject: deleteTarget?.kind === "single" ? deleteTarget.message.subject : "" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {deleteError && <p role="alert" className="text-sm text-destructive">{deleteError}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>{tCommon("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive hover:bg-destructive/90 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            disabled={!deleteTarget}
            aria-disabled={deleting}
            aria-busy={deleting}
            onClick={event => {
              event.preventDefault()
              if (deleteTarget) void handleDelete(deleteTarget)
            }}
          >
            {deleting ? tList("bulkDeleting") : tCommon("delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>
  )
}
