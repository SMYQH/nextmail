import { Header } from "@/components/layout/header"
import { ThreeColumnLayout } from "@/components/emails/three-column-layout"
import { NoPermissionDialog } from "@/components/no-permission-dialog"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { checkPermission } from "@/lib/auth"
import { PERMISSIONS } from "@/lib/permissions"
import type { Locale } from "@/i18n/config"


export default async function MailboxPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale: localeFromParams } = await params
  const locale = localeFromParams as Locale
  const session = await auth()
  
  if (!session?.user) {
    redirect(`/${locale}`)
  }

  const hasPermission = await checkPermission(PERMISSIONS.MANAGE_EMAIL)

  return (
    <div className="fluent-shell h-dvh overflow-hidden">
      <div className="relative z-10 container mx-auto h-full px-4 lg:px-8 max-w-[1600px]">
        <Header />
        <main className="fluent-page-enter h-full">
          {hasPermission ? (
            <ThreeColumnLayout />
          ) : (
            <NoPermissionDialog />
          )}
        </main>
      </div>
    </div>
  )
}
