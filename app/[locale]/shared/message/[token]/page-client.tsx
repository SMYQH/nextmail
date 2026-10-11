"use client"

import { useTranslations } from "next-intl"
import { BrandHeader } from "@/components/ui/brand-header"
import { FloatingLanguageSwitcher } from "@/components/layout/floating-language-switcher"
import { SharedMessageDetail } from "@/components/emails/shared-message-detail"
import { SharedDateTime } from "@/components/emails/shared-date-time"
import { isPermanentExpiry } from "@/lib/shared-date"

interface MessageDetail {
  id: string
  from_address?: string
  to_address?: string
  subject: string
  content?: string
  html?: string
  received_at?: Date
  sent_at?: Date
  expiresAt?: Date
  emailAddress?: string
  emailExpiresAt?: Date
}

interface SharedMessagePageClientProps {
  message: MessageDetail
  locale: string
  initialMessageTimeText: string
  initialEmailExpiryText?: string
}

export function SharedMessagePageClient({
  message,
  locale,
  initialMessageTimeText,
  initialEmailExpiryText,
}: SharedMessagePageClientProps) {
  const t = useTranslations("emails")
  const tShared = useTranslations("emails.shared")

  return (
    <div className="fluent-shell min-h-screen">
      <div className="relative z-10 container mx-auto p-4 max-w-7xl">
        <BrandHeader
          title={message.emailAddress || message.to_address || message.subject}
          subtitle={!message.emailExpiresAt || !Number.isFinite(new Date(message.emailExpiresAt).getTime())
            ? tShared("sharedMessage")
            : isPermanentExpiry(message.emailExpiresAt)
              ? tShared("permanent")
              : (
                <>
                  {tShared("expiresAt")}: {" "}
                  <SharedDateTime
                    value={message.emailExpiresAt}
                    locale={locale}
                    initialText={initialEmailExpiryText}
                  />
                </>
              )}
          ctaText={tShared("createOwnEmail")}
        />

        <div className="mt-6">
          <div className="fluent-pane overflow-hidden h-[calc(100vh-260px)] lg:h-[calc(100vh-280px)]">
            <SharedMessageDetail
              locale={locale}
              initialTimeText={initialMessageTimeText}
              message={{
                ...message,
                received_at: message.received_at ? new Date(message.received_at).getTime() : undefined,
                sent_at: message.sent_at ? new Date(message.sent_at).getTime() : undefined
              }}
              loading={false}
              t={{
                messageContent: t("layout.messageContent"),
                selectMessage: t("layout.selectMessage"),
                loading: tShared("loading"),
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
      </div>
      
      <FloatingLanguageSwitcher />
    </div>
  )
}
