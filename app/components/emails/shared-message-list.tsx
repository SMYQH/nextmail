"use client"

import { Mail, Calendar, RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"
import { useThrottle } from "@/hooks/use-throttle"
import { Button } from "@/components/ui/button"
import { SharedDateTime } from "./shared-date-time"

interface Message {
  id: string
  from_address?: string
  to_address?: string
  subject: string
  received_at?: number
  sent_at?: number
}

interface SharedMessageListProps {
  messages: Message[]
  locale: string
  initialTimeTexts?: Record<string, string>
  selectedMessageId?: string | null
  onMessageSelect: (messageId: string) => void
  onLoadMore?: () => void
  onRefresh?: () => void
  loading?: boolean
  loadingMore?: boolean
  refreshing?: boolean
  hasMore?: boolean
  total?: number
  t: {
    received: string
    noMessages: string
    messageCount: string
    loading: string
    loadingMore: string
  }
}

export function SharedMessageList({
  messages,
  locale,
  initialTimeTexts,
  selectedMessageId,
  onMessageSelect,
  onLoadMore,
  onRefresh,
  loading = false,
  loadingMore = false,
  refreshing = false,
  hasMore = false,
  total = 0,
  t,
}: SharedMessageListProps) {
  const handleScroll = useThrottle((e: React.UIEvent<HTMLDivElement>) => {
    if (loadingMore || !hasMore || !onLoadMore) return

    const { scrollHeight, scrollTop, clientHeight } = e.currentTarget
    const threshold = clientHeight * 1.5
    const remainingScroll = scrollHeight - scrollTop

    if (remainingScroll <= threshold) {
      onLoadMore()
    }
  }, 200)

  return (
    <div className="h-full flex flex-col">
      <div className="p-2.5 flex justify-between items-center border-b border-border/70 bg-secondary/20">
        <Button
          variant="ghost"
          size="icon"
          onClick={onRefresh}
          disabled={refreshing || loading}
          className="h-8 w-8"
              aria-busy={refreshing}
        >
          <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
        </Button>
        <span className="text-xs text-muted-foreground">
          {total > 0 ? `${total} ${t.messageCount}` : t.noMessages}
        </span>
      </div>

      <div className="flex-1 overflow-auto" onScroll={handleScroll}>
        {loading ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
            <RefreshCw className="h-6 w-6 animate-spin mx-auto text-primary mb-2" />
            {t.loading}
          </div>
        ) : messages.length > 0 ? (
          <div className="divide-y divide-border/60">
            {messages.map((message) => (
              <button
                key={message.id}
                type="button"
                onClick={() => onMessageSelect(message.id)}
                aria-pressed={selectedMessageId === message.id}
                className={cn(
                  "fluent-list-item w-full p-3 text-left cursor-pointer rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary",
                  selectedMessageId === message.id && "is-selected"
                )}
              >
                <span className="flex items-start gap-3">
                  <Mail className="w-4 h-4 text-primary/60 mt-1" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-sm truncate">
                      {message.subject}
                    </span>
                    <span className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="truncate">
                        {message.from_address || message.to_address || ""}
                      </span>
                      <span className="flex items-center gap-1">
                        <Calendar className="w-3 h-3" />
                        <SharedDateTime
                          value={message.received_at || message.sent_at || 0}
                          locale={locale}
                          initialText={initialTimeTexts?.[message.id]}
                        />
                      </span>
                    </span>
                  </span>
                </span>
              </button>
            ))}
            {loadingMore && (
              <div className="text-center text-sm text-muted-foreground py-2">
                {t.loadingMore}
              </div>
            )}
          </div>
        ) : (
          <div className="p-4 text-center text-sm text-muted-foreground">
            {t.noMessages}
          </div>
        )}
      </div>
    </div>
  )
}
