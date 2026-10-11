import { LoginForm } from "@/components/auth/login-form"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import type { Locale } from "@/i18n/config"
import { getTurnstileConfig } from "@/lib/turnstile"
import { getOAuthProviderAvailability } from "@/lib/oauth-providers"


export default async function LoginPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale: localeFromParams } = await params
  const locale = localeFromParams as Locale
  const session = await auth()
  
  if (session?.user) {
    redirect(`/${locale}`)
  }

  const turnstile = await getTurnstileConfig()

  return (
    <div className="fluent-shell min-h-screen flex items-center justify-center px-4">
      <div className="fluent-page-enter relative z-10 w-full flex justify-center">
        <LoginForm
          oauthProviders={getOAuthProviderAvailability()}
          turnstile={{ enabled: turnstile.enabled, siteKey: turnstile.siteKey }}
        />
      </div>
    </div>
  )
}
