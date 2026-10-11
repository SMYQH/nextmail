import { Header } from "@/components/layout/header"
import { auth } from "@/lib/auth"
import { Shield, Share2, Clock, Code2 } from "lucide-react"
import { ActionButton } from "@/components/home/action-button"
import { FeatureCard } from "@/components/home/feature-card"
import { BrandIcon } from "@/components/ui/brand-icon"
import { getTranslations } from "next-intl/server"
import type { Locale } from "@/i18n/config"


export default async function Home({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale: localeFromParams } = await params
  const locale = localeFromParams as Locale
  const session = await auth()
  const t = await getTranslations({ locale, namespace: "home" })

  return (
    <div className="fluent-shell min-h-screen">
      <div className="relative z-10 container mx-auto px-4 lg:px-8 max-w-[1600px]">
        <Header />
        <main className="pt-16">
          <div className="min-h-[calc(100svh-4rem)] flex items-center py-10 sm:py-16">
            <div className="fluent-stagger w-full max-w-4xl mx-auto space-y-8 sm:space-y-10">
              <section className="space-y-7 px-2 sm:px-0">
                <div className="flex items-center gap-5 sm:gap-6">
                  <BrandIcon size={80} className="shrink-0" />
                  <div className="space-y-1.5">
                    <h1 className="text-3xl sm:text-5xl font-semibold tracking-tight leading-tight">
                      {t("title")}
                    </h1>
                    <p className="text-base sm:text-lg text-muted-foreground">
                      {t("subtitle")}
                    </p>
                  </div>
                </div>
                <p className="max-w-xl text-base leading-relaxed text-muted-foreground">
                  {t("description")}
                </p>
                <ActionButton isLoggedIn={!!session} />
              </section>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 px-2 sm:px-0">
                <FeatureCard
                  icon={<Shield className="w-5 h-5" />}
                  title={t("features.privacy.title")}
                  description={t("features.privacy.description")}
                />
                <FeatureCard
                  icon={<Share2 className="w-5 h-5" />}
                  title={t("features.instant.title")}
                  description={t("features.instant.description")}
                />
                <FeatureCard
                  icon={<Clock className="w-5 h-5" />}
                  title={t("features.expiry.title")}
                  description={t("features.expiry.description")}
                />
                <FeatureCard
                  icon={<Code2 className="w-5 h-5" />}
                  title={t("features.openapi.title")}
                  description={t("features.openapi.description")}
                />
              </div>

            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
