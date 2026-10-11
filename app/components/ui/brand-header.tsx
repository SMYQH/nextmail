"use client"

import Link from "next/link"
import type { ReactNode } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { ExternalLink, Mail } from "lucide-react"
import { BrandIcon } from "@/components/ui/brand-icon"

interface BrandHeaderProps {
  title?: string
  subtitle?: ReactNode
  ctaText?: string
}

export function BrandHeader({
  title,
  subtitle,
  ctaText,
}: BrandHeaderProps) {
  const t = useTranslations("emails.shared.brand")

  const displayTitle = title || t("title")
  const displaySubtitle = subtitle || t("subtitle")
  const displayCtaText = ctaText || t("cta")
  return (
    <div className="text-center space-y-4 lg:pb-4">
      <div className="flex justify-center pt-2">
        <Link
          href="https://nextmail.pages.dev"
          className="flex items-center gap-3 rounded-md hover:opacity-80 transition-opacity group"
        >
          <BrandIcon
            size={48}
            className="shrink-0"
          />
          <span className="text-3xl font-semibold tracking-tight text-foreground">
            NextMail
          </span>
        </Link>
      </div>

      <div className="space-y-3">
        <h1 className="text-2xl md:text-3xl font-semibold text-foreground">
          {displayTitle}
        </h1>
        <p className="text-muted-foreground max-w-md mx-auto">
          {displaySubtitle}
        </p>
      </div>

      <div className="flex justify-center">
        <Button
          asChild
          size="lg"
          className="gap-2 px-8 min-h-10 h-auto py-1"
        >
          <Link href="/" target="_blank" rel="noopener noreferrer">
            <Mail className="w-5 h-5" />
            {displayCtaText}
            <ExternalLink className="w-4 h-4" />
          </Link>
        </Button>
      </div>
    </div>
  )
}
