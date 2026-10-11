"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Crown } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"

export function InitializeEmperorPanel({ accountName }: { accountName: string }) {
  const t = useTranslations("profile.initializeEmperor")
  const [open, setOpen] = useState(false)
  const [isClaiming, setIsClaiming] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const claimEmperor = async () => {
    if (isClaiming || unavailable) return
    setIsClaiming(true)
    setError(null)
    try {
      const response = await fetch("/api/roles/init-emperor", { method: "POST" })
      if (response.status === 409) {
        setUnavailable(true)
        setOpen(false)
        setError(t("alreadyClaimed"))
      } else if (response.status === 401) {
        setError(t("unauthorized"))
      } else if (!response.ok) {
        setError(t("failed"))
      } else {
        // Reload both the server profile and the client session/permission state.
        window.location.reload()
        return
      }
    } catch {
      setError(t("failed"))
    }
    setIsClaiming(false)
  }

  return (
    <div className="fluent-panel p-6 space-y-4">
      <div className="flex items-center gap-2">
        <Crown className="w-5 h-5 text-primary" aria-hidden="true" />
        <h2 className="text-lg font-semibold">{t("title")}</h2>
      </div>
      <p className="text-sm text-muted-foreground">{t("description")}</p>
      {!open && error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      <AlertDialog open={open} onOpenChange={(nextOpen) => {
        if (!isClaiming) {
          setOpen(nextOpen)
          if (nextOpen) setError(null)
        }
      }}>
        <AlertDialogTrigger asChild>
          <Button disabled={unavailable}>{t("claim")}</Button>
        </AlertDialogTrigger>
        <AlertDialogContent aria-busy={isClaiming}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription className="break-words">
              {t("confirmDescription", { account: accountName })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isClaiming}>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction disabled={isClaiming} onClick={(event) => {
              event.preventDefault()
              void claimEmperor()
            }}>
              {isClaiming ? t("claiming") : t("claim")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
