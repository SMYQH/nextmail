"use client"

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { EmailList } from "./email-list"
import { MessageListContainer } from "./message-list-container"
import { MessageView } from "./message-view"
import { SendDialog } from "./send-dialog"
import { cn } from "@/lib/utils"
import { useCopy } from "@/hooks/use-copy"
import { useSendPermission } from "@/hooks/use-send-permission"
import { Copy, Inbox, MailOpen } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useUserRole } from "@/hooks/use-user-role"
import { ROLES } from "@/lib/permissions"

interface Email {
  id: string
  address: string
  isCatchAll?: boolean
}

export function ThreeColumnLayout() {
  const t = useTranslations("emails.layout")
  const tCommon = useTranslations("common.actions")
  const [selectedEmail, setSelectedEmail] = useState<Email | null>(null)
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null)
  const [selectedMessageType, setSelectedMessageType] = useState<'received' | 'sent'>('received')
  const [selectedWasUnread, setSelectedWasUnread] = useState(false)
  const handleMessageRead = useCallback(() => setSelectedWasUnread(false), [])
  const [refreshTrigger, setRefreshTrigger] = useState(0)
  const [isDesktop, setIsDesktop] = useState(true)
  useEffect(() => {
    const media = window.matchMedia('(min-width: 1024px)')
    const update = () => setIsDesktop(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const { copyToClipboard } = useCopy()
  const { role } = useUserRole()
  const { canSend: canSendEmails } = useSendPermission(selectedEmail?.address)

  const columnClass = "fluent-pane overflow-hidden flex flex-col"
  const headerClass = "fluent-pane-header px-3 flex items-center justify-between shrink-0"
  const titleClass = "text-sm font-semibold min-w-0 truncate"

  // 移动端视图逻辑
  const getMobileView = () => {
    if (selectedMessageId) return "message"
    if (selectedEmail) return "emails"
    return "list"
  }

  const mobileView = getMobileView()

  const copyEmailAddress = () => {
    copyToClipboard(selectedEmail?.address || "")
  }

  const handleMessageSelect = (messageId: string | null, messageType: 'received' | 'sent' = 'received', wasUnread = false) => {
    setSelectedMessageId(messageId)
    setSelectedMessageType(messageType)
    setSelectedWasUnread(wasUnread)
  }

  const handleSendSuccess = () => {
    setRefreshTrigger(prev => prev + 1)
  }

  return (
    <div className="pb-5 pt-20 h-full flex flex-col">
      {/* 桌面端三栏布局 */}
      {isDesktop && <div className="fluent-mail-workspace hidden lg:grid grid-cols-12 h-full min-h-0">
        <div className={cn("col-span-3", columnClass)}>
          <div className={headerClass}>
            <h2 className={titleClass}>{t("myEmails")}</h2>
          </div>
          <div className="flex-1 overflow-auto">
            <EmailList
              onEmailSelect={(email) => {
                setSelectedEmail(email)
                setSelectedMessageId(null)
              }}
              selectedEmailId={selectedEmail?.id}
            />
          </div>
        </div>

        <div className={cn("col-span-4", columnClass)}>
          <div className={headerClass}>
            {selectedEmail ? (
              <div className="w-full flex justify-between items-center gap-2">
                <div className="flex flex-1 min-w-0 items-center gap-2">
                  <h2 className={titleClass}>{selectedEmail.address}</h2>
                  <Button type="button" variant="ghost" size="icon" aria-label={tCommon("copy")} className="h-8 w-8 shrink-0" onClick={copyEmailAddress}>
                    <Copy className="size-4" />
                  </Button>
                </div>
                {selectedEmail && canSendEmails && (
                  <SendDialog
                    emailId={selectedEmail.id}
                    fromAddress={selectedEmail.address}
                    allowCustomFrom={Boolean(selectedEmail.isCatchAll && role === ROLES.EMPEROR)}
                    onSendSuccess={handleSendSuccess}
                  />
                )}
                </div>
              ) : (
                <h2 className={titleClass}>{t("messageList")}</h2>
              )}
          </div>
          {selectedEmail && (
            <div className="fluent-view-enter flex-1 overflow-auto">
              <MessageListContainer
                email={selectedEmail}
                onMessageSelect={handleMessageSelect}
                selectedMessageId={selectedMessageId}
                refreshTrigger={refreshTrigger}
              />
            </div>
          )}
          {!selectedEmail && (
            <div className="fluent-empty-state">
              <div className="fluent-mark p-4"><Inbox className="h-7 w-7 text-primary" aria-hidden="true" /></div>
              <p className="max-w-52 leading-relaxed">{t("selectEmail")}</p>
            </div>
          )}
        </div>

        <div className={cn("col-span-5", columnClass)}>
          <div className={headerClass}>
            <h2 className={titleClass}>
              {t("messageContent")}
            </h2>
          </div>
          {selectedEmail && selectedMessageId && (
            <div className="flex-1 overflow-auto">
              <MessageView
                key={`${selectedEmail.id}:${selectedMessageId}`}
                emailId={selectedEmail.id}
                messageId={selectedMessageId}
                messageType={selectedMessageType}
                wasUnread={selectedWasUnread}
                onRead={handleMessageRead}
                onClose={() => setSelectedMessageId(null)}
              />
            </div>
          )}
          {!selectedMessageId && (
            <div className="fluent-empty-state">
              <MailOpen className="h-12 w-12 text-muted-foreground/40" strokeWidth={1} aria-hidden="true" />
              <p className="max-w-52 leading-relaxed">{t("selectMessage")}</p>
            </div>
          )}
        </div>
      </div>}

      {/* 移动端单栏布局 */}
      {!isDesktop && <div className="lg:hidden h-full min-h-0">
        <div className={cn("h-full", columnClass)}>
          {mobileView === "list" && (
            <>
              <div className={headerClass}>
                <h2 className={titleClass}>{t("myEmails")}</h2>
              </div>
              <div className="fluent-view-enter flex-1 overflow-auto">
                <EmailList
                  onEmailSelect={(email) => {
                    setSelectedEmail(email)
                  }}
                  selectedEmailId={selectedEmail?.id}
                />
              </div>
            </>
          )}

          {mobileView === "emails" && selectedEmail && (
            <div className="fluent-view-enter h-full flex flex-col">
              <div className={cn(headerClass, "gap-2")}>
                <button
                  onClick={() => {
                    setSelectedEmail(null)
                  }}
                  className="text-sm text-primary shrink-0"
                >
                  {t("backToEmailList")}
                </button>
                <div className="flex-1 flex justify-between items-center gap-2 min-w-0">
                  <div className="flex flex-1 min-w-0 items-center gap-2">
                    <span className="truncate min-w-0 flex-1 text-right">{selectedEmail.address}</span>
                    <Button type="button" variant="ghost" size="icon" aria-label={tCommon("copy")} className="h-8 w-8 shrink-0" onClick={copyEmailAddress}>
                      <Copy className="size-4" />
                    </Button>
                  </div>
                  {canSendEmails && (
                    <SendDialog
                      emailId={selectedEmail.id}
                      fromAddress={selectedEmail.address}
                      allowCustomFrom={Boolean(selectedEmail.isCatchAll && role === ROLES.EMPEROR)}
                      onSendSuccess={handleSendSuccess}
                    />
                  )}
                </div>
              </div>
              <div className="flex-1 overflow-auto">
                <MessageListContainer
                  email={selectedEmail}
                  onMessageSelect={handleMessageSelect}
                  selectedMessageId={selectedMessageId}
                  refreshTrigger={refreshTrigger}
                />
              </div>
            </div>
          )}

          {mobileView === "message" && selectedEmail && selectedMessageId && (
            <div className="fluent-view-enter h-full flex flex-col">
              <div className={headerClass}>
                <button
                  onClick={() => setSelectedMessageId(null)}
                  className="text-sm text-primary"
                >
                  {t("backToMessageList")}
                </button>
                <span className="text-sm font-medium">{t("messageContent")}</span>
              </div>
              <div className="flex-1 overflow-auto">
                <MessageView
                key={`${selectedEmail.id}:${selectedMessageId}`}
                  emailId={selectedEmail.id}
                  messageId={selectedMessageId}
                  messageType={selectedMessageType}
                  wasUnread={selectedWasUnread}
                  onRead={handleMessageRead}
                  onClose={() => setSelectedMessageId(null)}
                />
              </div>
            </div>
          )}
        </div>
      </div>}
    </div>
  )
}
