"use client"

import { useState, useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { BrandHeader } from "@/components/ui/brand-header"
import { FloatingLanguageSwitcher } from "@/components/layout/floating-language-switcher"
import { SharedMessageList } from "@/components/emails/shared-message-list"
import { SharedMessageDetail } from "@/components/emails/shared-message-detail"
import { SharedDateTime } from "@/components/emails/shared-date-time"
import { EMAIL_CONFIG } from "@/config"
import { LatestRequestGate } from "@/lib/latest-request-gate"
import { mergeRefreshedMessages } from "@/lib/message-list-refresh"
import { isPermanentExpiry } from "@/lib/shared-date"

interface Email {
  id: string
  address: string
  createdAt: Date
  expiresAt: Date
}

interface Message {
  id: string
  from_address?: string
  to_address?: string
  subject: string
  received_at?: Date
  sent_at?: Date
}

interface MessageDetail extends Message {
  content?: string
  html?: string
}

interface SharedEmailPageClientProps {
  email: Email
  initialMessages: Message[]
  initialNextCursor: string | null
  initialTotal: number
  locale: string
  initialExpiryText?: string
  initialMessageTimeTexts: Record<string, string>
  token: string
}

export function SharedEmailPageClient({
  email,
  initialMessages,
  initialNextCursor,
  initialTotal,
  locale,
  initialExpiryText,
  initialMessageTimeTexts,
  token
}: SharedEmailPageClientProps) {
  const t = useTranslations("emails")
  const tShared = useTranslations("emails.shared")

  const [messages, setMessages] = useState<Message[]>(initialMessages)
  const [selectedMessage, setSelectedMessage] = useState<MessageDetail | null>(null)
  const [messageLoading, setMessageLoading] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor)
  const nextCursorRef = useRef<string | null>(initialNextCursor)
  const [loadingMore, setLoadingMore] = useState(false)
  const [total, setTotal] = useState(initialTotal)
  const [refreshing, setRefreshing] = useState(false)
  const pollTimeoutRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const messagesRef = useRef<Message[]>(initialMessages)
  const listRequestGateRef = useRef(new LatestRequestGate())
  const activeListRequestRef = useRef<AbortController | null>(null)
  const detailRequestGateRef = useRef(new LatestRequestGate())
  const activeDetailRequestRef = useRef<AbortController | null>(null)

  // 当 messages 改变时更新 ref
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  type FetchKind = "poll" | "refresh" | "more"

  const replaceMessages = (nextMessages: Message[]) => {
    messagesRef.current = nextMessages
    setMessages(nextMessages)
  }

  const replaceNextCursor = (cursor: string | null) => {
    nextCursorRef.current = cursor
    setNextCursor(cursor)
  }

  const fetchMessages = async (cursor?: string, kind: FetchKind = cursor ? "more" : "poll") => {
    if (kind === "poll" && activeListRequestRef.current) return

    const ticket = listRequestGateRef.current.begin(`shared-list:${token}`)
    activeListRequestRef.current?.abort()
    const controller = new AbortController()
    activeListRequestRef.current = controller

    if (kind === "refresh") {
      setRefreshing(true)
      setLoadingMore(false)
    }
    if (kind === "more") {
      setLoadingMore(true)
      setRefreshing(false)
    }

    try {
      const url = new URL(`/api/shared/${token}/messages`, window.location.origin)
      if (cursor) {
        url.searchParams.set('cursor', cursor)
      }

      const messagesResponse = await fetch(url, { signal: controller.signal })
      if (messagesResponse.ok) {
        const messagesData = await messagesResponse.json() as {
          messages: Message[]
          nextCursor: string | null
          total: number
        }
        if (!ticket.isCurrent()) return

        if (!cursor) {
          const result = mergeRefreshedMessages(
            messagesData.messages,
            messagesRef.current,
            messagesData.nextCursor,
            nextCursorRef.current,
          )
          replaceMessages(result.messages)
          replaceNextCursor(result.nextCursor)
          setTotal(messagesData.total)
          return
        }
        // 加载更多：追加到列表末尾
        replaceMessages([...messagesRef.current, ...(messagesData.messages || [])])
        replaceNextCursor(messagesData.nextCursor)
        setTotal(messagesData.total)
      }
    } catch (err) {
      if (!controller.signal.aborted && ticket.isCurrent()) {
        console.error("Failed to fetch messages:", err)
      }
    } finally {
      if (ticket.isCurrent()) {
        activeListRequestRef.current = null
        setLoadingMore(false)
        setRefreshing(false)
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

  // 启动轮询
  useEffect(() => {
    const listRequestGate = listRequestGateRef.current
    const detailRequestGate = detailRequestGateRef.current
    startPolling()
    return () => {
      stopPolling()
      listRequestGate.invalidate()
      activeListRequestRef.current?.abort()
      activeListRequestRef.current = null
      detailRequestGate.invalidate()
      activeDetailRequestRef.current?.abort()
      activeDetailRequestRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  const handleLoadMore = () => {
    if (nextCursor && !loadingMore) {
      void fetchMessages(nextCursor, "more")
    }
  }

  const fetchMessageDetail = async (messageId: string) => {
    const ticket = detailRequestGateRef.current.begin(`shared-detail:${token}`)
    activeDetailRequestRef.current?.abort()
    const controller = new AbortController()
    activeDetailRequestRef.current = controller
    setSelectedMessage(null)
    setMessageLoading(true)

    try {
      const response = await fetch(`/api/shared/${token}/messages/${messageId}`, { signal: controller.signal })

      if (!response.ok) {
        throw new Error("Failed to load message")
      }

      const data = await response.json() as { message: MessageDetail }
      if (!ticket.isCurrent()) return
      setSelectedMessage(data.message)
    } catch (err) {
      if (!controller.signal.aborted && ticket.isCurrent()) {
        console.error("Failed to fetch message:", err)
      }
    } finally {
      if (ticket.isCurrent()) {
        activeDetailRequestRef.current = null
        setMessageLoading(false)
      }
    }
  }

  const clearMessageDetail = () => {
    detailRequestGateRef.current.invalidate()
    activeDetailRequestRef.current?.abort()
    activeDetailRequestRef.current = null
    setSelectedMessage(null)
    setMessageLoading(false)
  }

  return (
    <div className="fluent-shell min-h-screen">
      <div className="relative z-10 container mx-auto p-4 max-w-7xl">
        <BrandHeader
          title={email.address}
          subtitle={(() => {
            const expiresDate = new Date(email.expiresAt)
            if (!Number.isFinite(expiresDate.getTime())) return tShared("sharedMailbox")
            if (isPermanentExpiry(email.expiresAt)) return tShared("permanent")
            return (
              <>
                {tShared("expiresAt")}: {" "}
                <SharedDateTime
                  value={email.expiresAt}
                  locale={locale}
                  format="separate-date-time"
                  initialText={initialExpiryText}
                />
              </>
            )
          })()}
          ctaText={tShared("createOwnEmail")}
        />

        {/* 桌面端双栏布局 */}
        <div className="hidden lg:grid grid-cols-2 gap-4 h-[calc(100vh-280px)] mt-6">
          <div className="fluent-pane overflow-hidden">
            <SharedMessageList
              locale={locale}
              initialTimeTexts={initialMessageTimeTexts}
              messages={messages.map(msg => ({
                ...msg,
                received_at: (() => {
                  if (!msg.received_at) return undefined
                  try {
                    const date = new Date(msg.received_at)
                    return isNaN(date.getTime()) ? undefined : date.getTime()
                  } catch {
                    return undefined
                  }
                })(),
                sent_at: (() => {
                  if (!msg.sent_at) return undefined
                  try {
                    const date = new Date(msg.sent_at)
                    return isNaN(date.getTime()) ? undefined : date.getTime()
                  } catch {
                    return undefined
                  }
                })()
              }))}
              selectedMessageId={selectedMessage?.id}
              onMessageSelect={fetchMessageDetail}
              onLoadMore={handleLoadMore}
              onRefresh={handleRefresh}
              loading={false}
              loadingMore={loadingMore}
              refreshing={refreshing}
              hasMore={!!nextCursor}
              total={total}
              t={{
                received: t("messages.received"),
                noMessages: t("messages.noMessages"),
                messageCount: t("messages.messageCount"),
                loading: t("messageView.loading"),
                loadingMore: t("messages.loadingMore")
              }}
            />
          </div>

          <div className="fluent-pane overflow-hidden">
            <SharedMessageDetail
              locale={locale}
              message={selectedMessage ? {
                ...selectedMessage,
                received_at: (() => {
                  if (!selectedMessage.received_at) return undefined
                  try {
                    const date = new Date(selectedMessage.received_at)
                    return isNaN(date.getTime()) ? undefined : date.getTime()
                  } catch {
                    return undefined
                  }
                })(),
                sent_at: (() => {
                  if (!selectedMessage.sent_at) return undefined
                  try {
                    const date = new Date(selectedMessage.sent_at)
                    return isNaN(date.getTime()) ? undefined : date.getTime()
                  } catch {
                    return undefined
                  }
                })()
              } : null}
              loading={messageLoading}
              t={{
                messageContent: t("layout.messageContent"),
                selectMessage: t("layout.selectMessage"),
                loading: t("messageView.loading"),
                from: t("messageView.from"),
                to: t("messageView.to"),
                subject: t("messages.subject"),
                time: t("messageView.time"),
                htmlFormat: t("messageView.htmlFormat"),
                textFormat: t("messageView.textFormat")
              }}
            />
          </div>
        </div>

        {/* 移动端单栏布局 */}
        <div className="lg:hidden h-[calc(100vh-260px)] mt-6">
          <div className="fluent-pane overflow-hidden h-full flex flex-col">
            {!selectedMessage ? (
              // 消息列表视图
              <SharedMessageList
                locale={locale}
                initialTimeTexts={initialMessageTimeTexts}
                messages={messages.map(msg => ({
                  ...msg,
                  received_at: (() => {
                    if (!msg.received_at) return undefined
                    try {
                      const date = new Date(msg.received_at)
                      return isNaN(date.getTime()) ? undefined : date.getTime()
                    } catch {
                      return undefined
                    }
                  })(),
                  sent_at: (() => {
                    if (!msg.sent_at) return undefined
                    try {
                      const date = new Date(msg.sent_at)
                      return isNaN(date.getTime()) ? undefined : date.getTime()
                    } catch {
                      return undefined
                    }
                  })()
                }))}
                selectedMessageId={null}
                onMessageSelect={fetchMessageDetail}
                onLoadMore={handleLoadMore}
                onRefresh={handleRefresh}
                loading={false}
                loadingMore={loadingMore}
                refreshing={refreshing}
                hasMore={!!nextCursor}
                total={total}
                t={{
                  received: t("messages.received"),
                  noMessages: t("messages.noMessages"),
                  messageCount: t("messages.messageCount"),
                  loading: t("messageView.loading"),
                  loadingMore: t("messages.loadingMore")
                }}
              />
            ) : (
              // 消息详情视图
              <>
                <div className="fluent-pane-header p-2 flex items-center justify-between shrink-0">
                  <button
                    onClick={clearMessageDetail}
                    className="text-sm text-primary"
                  >
                    {t("layout.backToMessageList")}
                  </button>
                  <span className="text-sm font-medium">{t("layout.messageContent")}</span>
                </div>
                <div className="flex-1 overflow-auto">
                  <SharedMessageDetail
                    locale={locale}
                    message={{
                      ...selectedMessage,
                      received_at: (() => {
                        if (!selectedMessage.received_at) return undefined
                        try {
                          const date = new Date(selectedMessage.received_at)
                          return isNaN(date.getTime()) ? undefined : date.getTime()
                        } catch {
                          return undefined
                        }
                      })(),
                      sent_at: (() => {
                        if (!selectedMessage.sent_at) return undefined
                        try {
                          const date = new Date(selectedMessage.sent_at)
                          return isNaN(date.getTime()) ? undefined : date.getTime()
                        } catch {
                          return undefined
                        }
                      })()
                    }}
                    loading={messageLoading}
                    t={{
                      messageContent: t("layout.messageContent"),
                      selectMessage: t("layout.selectMessage"),
                      loading: t("messageView.loading"),
                      from: t("messageView.from"),
                      to: t("messageView.to"),
                      subject: t("messages.subject"),
                      time: t("messageView.time"),
                      htmlFormat: t("messageView.htmlFormat"),
                      textFormat: t("messageView.textFormat")
                    }}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <FloatingLanguageSwitcher />
    </div>
  )
}
