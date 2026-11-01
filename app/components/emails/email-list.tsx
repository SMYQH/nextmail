"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useSession } from "next-auth/react"
import { useLocale, useTranslations } from "next-intl"
import { SharedDateTime } from "./shared-date-time"
import { isPermanentExpiry } from "@/lib/shared-date"
import { CreateDialog } from "./create-dialog"
import { ShareDialog } from "./share-dialog"
import { Inbox, Mail, RefreshCw, Trash2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { useThrottle } from "@/hooks/use-throttle"
import { EMAIL_CONFIG } from "@/config"
import { useToast } from "@/components/ui/use-toast"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { ROLES } from "@/lib/permissions"
import { useUserRole } from "@/hooks/use-user-role"
import { useConfig } from "@/hooks/use-config"
import { mergeRefreshedMessages } from "@/lib/message-list-refresh"
import { MAILBOX_UPDATE_EVENT, mailboxSnapshots, type MailboxUpdate } from "@/lib/mailbox-events"
import { LatestRequestGate } from "@/lib/latest-request-gate"
import { EmptyState } from "@/components/ui/empty-state"

interface Email {
  id: string
  address: string
  createdAt: number
  expiresAt: number
  isCatchAll?: boolean
  totalMessages?: number
  unreadMessages?: number
}

interface EmailListProps {
  onEmailSelect: (email: Email | null) => void
  selectedEmailId?: string
}

interface EmailResponse {
  emails: Email[]
  nextCursor: string | null
  total?: number
}

interface EmailListScope {
  userId: string | undefined
  domain: string
}

const MAX_SELECTED_EMAILS = 40

export function EmailList({ onEmailSelect, selectedEmailId }: EmailListProps) {
  const { data: session } = useSession()
  const userId = session?.user?.id
  const { config } = useConfig()
  const { role } = useUserRole()
  const locale = useLocale()
  const t = useTranslations("emails.list")
  const tCommon = useTranslations("common.actions")
  const [emails, setEmails] = useState<Email[]>([])
  const [domain, setDomain] = useState("")
  const gateRef = useRef(new LatestRequestGate())
  const emailsRef = useRef<Email[]>([])
  const emailListScopeRef = useRef<EmailListScope | null>(null)
  const emailListContainerRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const nextCursorRef = useRef<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [total, setTotal] = useState(0)
  const [emailToDelete, setEmailToDelete] = useState<Email | null>(null)
  const [selectedEmailIds, setSelectedEmailIds] = useState<Set<string>>(new Set())
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const bulkDeleteInFlightRef = useRef(false)
  const { toast } = useToast()

  const replaceEmails = useCallback((nextEmails: Email[]) => {
    emailsRef.current = nextEmails
    setEmails(nextEmails)
  }, [])

  const replaceNextCursor = useCallback((cursor: string | null) => {
    nextCursorRef.current = cursor
    setNextCursor(cursor)
  }, [])

  const fetchEmails = useCallback(async (cursor?: string) => {
    const ticket = gateRef.current.begin(domain)
    const snapshot = mailboxSnapshots.snapshot()
    try {
      const url = new URL("/api/emails", window.location.origin)
      if (domain) url.searchParams.set('domain', domain)
      if (cursor) {
        url.searchParams.set('cursor', cursor)
      }
      const response = await fetch(url)
      if (!response.ok) return
      const data = await response.json() as EmailResponse
      if (!ticket.isCurrent()) return
      const updatedEmails = data.emails.map(email => {
        const counts = mailboxSnapshots.reconcile(email.id, snapshot, { total: email.totalMessages, unread: email.unreadMessages })
        return { ...email, totalMessages: counts.total, unreadMessages: counts.unread }
      })
      
      if (!cursor) {
        const result = mergeRefreshedMessages(
          updatedEmails,
          emailsRef.current,
          data.nextCursor,
          nextCursorRef.current,
          email => !email.isCatchAll,
        )
        replaceEmails(result.messages)
        replaceNextCursor(result.nextCursor)
        if (typeof data.total === "number") setTotal(data.total)
        return
      }
      replaceEmails([...emailsRef.current, ...updatedEmails])
      replaceNextCursor(data.nextCursor)
      if (typeof data.total === "number") setTotal(data.total)
    } catch (error) {
      console.error("Failed to fetch emails:", error)
    } finally {
      if (!ticket.isCurrent()) return
      setLoading(false)
      setRefreshing(false)
      setLoadingMore(false)
    }
  }, [domain, replaceEmails, replaceNextCursor])

  const handleRefresh = async () => {
    setRefreshing(true)
    await fetchEmails()
  }

  const handleScroll = useThrottle((e: React.UIEvent<HTMLDivElement>) => {
    if (loadingMore) return

    const { scrollHeight, scrollTop, clientHeight } = e.currentTarget
    const threshold = clientHeight * 1.5
    const remainingScroll = scrollHeight - scrollTop

    if (remainingScroll <= threshold && nextCursor) {
      setLoadingMore(true)
      fetchEmails(nextCursor)
    }
  }, 200)

  useEffect(() => {
    const scope = { userId, domain }
    const previousScope = emailListScopeRef.current
    const resetList = previousScope === null || previousScope.userId !== userId || previousScope.domain !== domain
    emailListScopeRef.current = scope
    if (resetList) {
      replaceEmails([])
      replaceNextCursor(null)
      setLoading(true)
      setRefreshing(false)
      setLoadingMore(false)
      setTotal(0)
      setEmailToDelete(null)
      setSelectedEmailIds(new Set())
      setBulkDeleteOpen(false)
      if (emailListContainerRef.current) emailListContainerRef.current.scrollTop = 0
    }
    if (session) fetchEmails()
    const gate = gateRef.current
    return () => gate.invalidate()
  }, [session, userId, domain, fetchEmails, replaceEmails, replaceNextCursor])

  useEffect(() => {
    const update = (event: Event) => {
      const detail = (event as CustomEvent<MailboxUpdate>).detail
      replaceEmails(emailsRef.current.map(email => email.id === detail.emailId ? {
        ...email,
        totalMessages: detail.total ?? Math.max(0, (email.totalMessages || 0) + detail.totalDelta),
        unreadMessages: detail.unread ?? Math.max(0, (email.unreadMessages || 0) + detail.unreadDelta),
      } : email))
    }
    window.addEventListener(MAILBOX_UPDATE_EVENT, update)
    return () => window.removeEventListener(MAILBOX_UPDATE_EVENT, update)
  }, [replaceEmails])

  const handleDelete = async (email: Email) => {
    try {
      const response = await fetch(`/api/emails/${email.id}`, {
        method: "DELETE"
      })

      if (!response.ok) {
        const data = await response.json()
        toast({
          title: t("error"),
          description: (data as { error: string }).error,
          variant: "destructive"
        })
        return
      }

      replaceEmails(emailsRef.current.filter(e => e.id !== email.id))
      setSelectedEmailIds(current => {
        if (!current.has(email.id)) return current
        const next = new Set(current)
        next.delete(email.id)
        return next
      })
      setTotal(prev => prev - 1)

      toast({
        title: t("success"),
        description: t("deleteSuccess")
      })
      
      if (selectedEmailId === email.id) {
        onEmailSelect(null)
      }
    } catch {
      toast({
        title: t("error"),
        description: t("deleteFailed"),
        variant: "destructive"
      })
    } finally {
      setEmailToDelete(null)
    }
  }

  const handleBulkDelete = async () => {
    const ids = [...selectedEmailIds]
    if (!ids.length || bulkDeleteInFlightRef.current) return

    bulkDeleteInFlightRef.current = true
    setBulkDeleting(true)
    try {
      const response = await fetch("/api/emails/bulk", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      })

      if (!response.ok) {
        toast({
          title: t("error"),
          description: response.status === 403 ? t("bulkDeleteUnavailable") : t("bulkDeleteFailed"),
          variant: "destructive",
        })
        return
      }

      const result = await response.json() as { success?: boolean; deletedIds?: unknown }
      const deletedIds = result.deletedIds
      if (
        result.success !== true ||
        !Array.isArray(deletedIds) ||
        deletedIds.length !== ids.length ||
        !ids.every(id => deletedIds.includes(id))
      ) {
        toast({
          title: t("error"),
          description: t("bulkDeleteFailed"),
          variant: "destructive",
        })
        return
      }

      const deletedSet = new Set(deletedIds as string[])
      gateRef.current.invalidate()
      replaceEmails(emailsRef.current.filter(email => !deletedSet.has(email.id)))
      setSelectedEmailIds(current => {
        const next = new Set(current)
        for (const id of deletedSet) next.delete(id)
        return next
      })
      setTotal(current => Math.max(0, current - deletedSet.size))
      setLoading(false)
      setLoadingMore(false)
      setRefreshing(false)
      if (selectedEmailId && deletedSet.has(selectedEmailId)) onEmailSelect(null)
      setBulkDeleteOpen(false)
      toast({
        title: t("success"),
        description: t("bulkDeleteSuccess", { count: deletedSet.size }),
      })
    } catch {
      toast({
        title: t("error"),
        description: t("bulkDeleteFailed"),
        variant: "destructive",
      })
    } finally {
      bulkDeleteInFlightRef.current = false
      setBulkDeleting(false)
    }
  }

  if (!session) return null

  return (
    <>
      <div className="flex flex-col h-full">
        <div className="p-2.5 flex justify-between items-center border-b border-border/70 bg-secondary/20">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              aria-label={tCommon("refresh")}
              onClick={handleRefresh}
              disabled={refreshing || bulkDeleting}
              className="h-8 w-8"
              aria-busy={refreshing}
            >
              <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
            </Button>
            <span className="text-xs text-muted-foreground">
              {role === ROLES.EMPEROR ? (
                t("emailCountUnlimited", { count: total })
              ) : (
                t("emailCount", { count: total, max: config?.maxEmails || EMAIL_CONFIG.MAX_ACTIVE_EMAILS })
              )}
            </span>
          </div>
          <CreateDialog onEmailCreated={handleRefresh} />
        </div>
        {selectedEmailIds.size > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 px-3 py-2">
            <span className="text-xs text-muted-foreground" role="status" aria-live="polite">
              {t("selectedCount", { count: selectedEmailIds.size })}
              {selectedEmailIds.size === MAX_SELECTED_EMAILS && ` · ${t("maxSelected")}`}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setBulkDeleteOpen(true)}
                disabled={bulkDeleting}
              >
                <Trash2 aria-hidden="true" className="mr-1.5 h-4 w-4" />
                {t("deleteSelected", { count: selectedEmailIds.size })}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectedEmailIds(new Set())}
                disabled={bulkDeleting}
              >
                {t("clearSelection")}
              </Button>
            </div>
          </div>
        )}
        <div role="group" className="flex shrink-0 gap-1 overflow-x-auto border-b border-border/70 p-2" aria-label={t("domainFilter")}>
          {["", ...(config?.emailDomainsArray || [])].map(value => (
            <Button key={value} variant={domain === value ? "secondary" : "ghost"} size="sm"
              aria-pressed={domain === value} onClick={() => setDomain(value)} className="shrink-0">
              {value || t("allDomains")}
            </Button>
          ))}
        </div>
        <div ref={emailListContainerRef} className="flex-1 overflow-auto p-1.5" onScroll={handleScroll}>
          {loading ? (
            <div className="text-center text-sm text-muted-foreground">{t("loading")}</div>
          ) : emails.length > 0 ? (
            <div className="space-y-1">
              {emails.map(email => (
                <div
                  key={email.id}
                  className={cn("fluent-list-item flex items-center gap-2 p-2 cursor-pointer text-sm group",
                    selectedEmailId === email.id && "is-selected",
                    email.isCatchAll && "border-b border-border/70"
                  )}
                >
                  {!email.isCatchAll && (
                    <div className="relative flex shrink-0 items-center">
                      <Checkbox
                        id={`mailbox-select-${email.id}`}
                        checked={selectedEmailIds.has(email.id)}
                        onChange={checked => setSelectedEmailIds(current => {
                          if (checked) {
                            if (current.has(email.id) || current.size >= MAX_SELECTED_EMAILS) return current
                            return new Set(current).add(email.id)
                          }
                          if (!current.has(email.id)) return current
                          const next = new Set(current)
                          next.delete(email.id)
                          return next
                        })}
                        disabled={bulkDeleting || (!selectedEmailIds.has(email.id) && selectedEmailIds.size >= MAX_SELECTED_EMAILS)}
                        className="h-8 w-8 rounded-[3px]"
                      />
                      <label htmlFor={`mailbox-select-${email.id}`} className="sr-only">
                        {t("selectMailbox", { email: email.address })}
                      </label>
                    </div>
                  )}
                  <button type="button" onClick={() => onEmailSelect(email)}
                    aria-pressed={selectedEmailId === email.id}
                    className="flex flex-1 min-w-0 items-center gap-2 text-left rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
                  {email.isCatchAll ? <Inbox aria-label={t("catchAll")} className="h-4 w-4 shrink-0 text-primary" /> : <Mail className="h-4 w-4 shrink-0 text-primary/60" />}
                  <div className="truncate flex-1">
                    <div className="font-medium truncate" title={email.address}>{email.address}</div>
                    <div className="text-xs text-muted-foreground">
                      <span className="block" aria-label={t("messageStats", { unread: email.unreadMessages || 0, total: email.totalMessages || 0 })}>
                        {email.unreadMessages || 0} / {email.totalMessages || 0}
                      </span>
                      {isPermanentExpiry(email.expiresAt) ? (
                        t("permanent")
                      ) : (
                        <>{t("expiresAt")}: <SharedDateTime value={email.expiresAt} locale={locale} /></>
                      )}
                    </div>
                  </div>
                  </button>
                  <div className="flex shrink-0 gap-1" onClick={(e) => e.stopPropagation()}>
                    <ShareDialog emailId={email.id} emailAddress={email.address} />
                    {!email.isCatchAll && <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      aria-label={tCommon("delete")}
                      disabled={bulkDeleting}
                      onClick={(e) => {
                        e.stopPropagation()
                        setEmailToDelete(email)
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>}
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
            <EmptyState message={t("noEmails")} />
          )}
        </div>
      </div>

      <AlertDialog open={!!emailToDelete} onOpenChange={() => setEmailToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteConfirm")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteDescription", { email: emailToDelete?.address || "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={() => emailToDelete && handleDelete(emailToDelete)}
            >
              {tCommon("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={bulkDeleteOpen}
        onOpenChange={open => {
          if (!bulkDeleting) setBulkDeleteOpen(open)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("bulkDeleteConfirm")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("bulkDeleteDescription", { count: selectedEmailIds.size })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkDeleting}>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              disabled={bulkDeleting || selectedEmailIds.size === 0}
              aria-busy={bulkDeleting}
              onClick={event => {
                event.preventDefault()
                void handleBulkDelete()
              }}
            >
              {bulkDeleting ? t("bulkDeleting") : t("deleteSelected", { count: selectedEmailIds.size })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
