import { getSharedEmail, getSharedEmailMessages } from "@/lib/shared-data"
import { formatSharedDate, isPermanentExpiry } from "@/lib/shared-date"
import { SharedErrorPage } from "@/components/emails/shared-error-page"
import { SharedEmailPageClient } from "./page-client"

interface PageProps {
  params: Promise<{
    token: string
    locale: string
  }>
}

export default async function SharedEmailPage({ params }: PageProps) {
  const { token, locale } = await params

  // 服务端获取数据
  const email = await getSharedEmail(token)

  if (!email) {
    return (
      <SharedErrorPage
        titleKey="emailNotFound"
        subtitleKey="linkExpired"
        errorKey="linkInvalid"
        descriptionKey="linkInvalidDescription"
        ctaTextKey="createOwnEmail"
      />
    )
  }

  // 获取初始消息列表
  const messagesResult = await getSharedEmailMessages(token)
  const initialExpiryText = isPermanentExpiry(email.expiresAt)
    ? undefined
    : formatSharedDate(email.expiresAt, locale, "separate-date-time", "UTC")
  const initialMessageTimeTexts = Object.fromEntries(messagesResult.messages.map(message => [
    message.id,
    formatSharedDate(message.received_at || message.sent_at || 0, locale, "date-time", "UTC"),
  ]))

  return (
    <SharedEmailPageClient
      key={token}
      email={email}
      initialMessages={messagesResult.messages}
      initialNextCursor={messagesResult.nextCursor}
      initialTotal={messagesResult.total}
      locale={locale}
      initialExpiryText={initialExpiryText}
      initialMessageTimeTexts={initialMessageTimeTexts}
      token={token}
    />
  )
}
