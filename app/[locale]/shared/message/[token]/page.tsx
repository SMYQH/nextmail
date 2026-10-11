import { getSharedMessage } from "@/lib/shared-data"
import { formatSharedDate, isPermanentExpiry } from "@/lib/shared-date"
import { SharedErrorPage } from "@/components/emails/shared-error-page"
import { SharedMessagePageClient } from "./page-client"

interface PageProps {
  params: Promise<{
    token: string
    locale: string
  }>
}

export default async function SharedMessagePage({ params }: PageProps) {
  const { token, locale } = await params
  
  // 服务端获取数据
  const message = await getSharedMessage(token)
  
  if (!message) {
    return (
      <SharedErrorPage
        titleKey="messageNotFound"
        subtitleKey="linkExpired"
        errorKey="linkInvalid"
        descriptionKey="linkInvalidDescription"
        ctaTextKey="createOwnEmail"
      />
    )
  }

  const initialMessageTimeText = formatSharedDate(
    message.sent_at || message.received_at || 0,
    locale,
    "date-time",
    "UTC",
  )
  const initialEmailExpiryText = message.emailExpiresAt && !isPermanentExpiry(message.emailExpiresAt)
    ? formatSharedDate(message.emailExpiresAt, locale, "date-time", "UTC")
    : undefined

  return (
    <SharedMessagePageClient
      message={message}
      locale={locale}
      initialMessageTimeText={initialMessageTimeText}
      initialEmailExpiryText={initialEmailExpiryText}
    />
  )
}
