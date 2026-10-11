import { Header } from "@/components/layout/header"
import { ProfileCard } from "@/components/profile/profile-card"
import { auth, hasEmperor } from "@/lib/auth"
import { redirect } from "next/navigation"
import type { Locale } from "@/i18n/config"


export default async function ProfilePage({
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

  const canInitializeEmperor = !await hasEmperor()

  return (
    <div className="fluent-shell min-h-screen">
      <div className="relative z-10 container mx-auto px-4 lg:px-8 max-w-[1600px]">
        <Header />
        <main className="pt-20 pb-5">
          <ProfileCard user={session.user} canInitializeEmperor={canInitializeEmperor} />
        </main>
      </div>
    </div>
  )
}
