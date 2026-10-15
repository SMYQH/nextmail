"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Copy, Plus, RefreshCw } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { nanoid } from "nanoid"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { EXPIRY_OPTIONS } from "@/types/email"
import { useCopy } from "@/hooks/use-copy"
import { useConfig } from "@/hooks/use-config"
import { isValidMailboxName } from "@/lib/mailbox-name"

interface CreateDialogProps {
  onEmailCreated: () => void
}

const EMPTY_DOMAINS: string[] = []

export function CreateDialog({ onEmailCreated }: CreateDialogProps) {
  const { config, loading: configLoading, error: configError, fetch: fetchConfig } = useConfig()
  const t = useTranslations("emails.create")
  const tList = useTranslations("emails.list")
  const tCommon = useTranslations("common.actions")
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [emailName, setEmailName] = useState("")
  const [currentDomain, setCurrentDomain] = useState("")
  const [expiryTime, setExpiryTime] = useState(EXPIRY_OPTIONS[1].value.toString())
  const { toast } = useToast()
  const { copyToClipboard } = useCopy()
  const mailboxName = emailName.trim().toLowerCase()
  const availableDomains = config?.availableEmailDomains ?? EMPTY_DOMAINS

  const generateRandomName = () => setEmailName(nanoid(8))

  const copyEmailAddress = () => {
    copyToClipboard(`${mailboxName}@${currentDomain}`)
  }

  const createEmail = async () => {
    if (!config || configLoading || !currentDomain) return

    if (mailboxName && !isValidMailboxName(mailboxName)) {
      toast({
        title: tList("error"),
        description: t("invalidName"),
        variant: "destructive"
      })
      return
    }

    setLoading(true)
    try {
      const response = await fetch("/api/emails/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: mailboxName,
          domain: currentDomain,
          expiryTime: parseInt(expiryTime)
        })
      })

      if (!response.ok) {
        const data = await response.json()
        toast({
          title: tList("error"),
          description: response.status === 409
            ? t("nameTaken")
            : (data as { error?: string }).error === "Email domain is not available to this user"
              ? t("domainUnavailable")
              : (data as { error: string }).error,
          variant: "destructive"
        })
        return
      }

      toast({
        title: tList("success"),
        description: t("success")
      })
      onEmailCreated()
      setOpen(false)
      setEmailName("")
    } catch {
      toast({
        title: tList("error"),
        description: t("failed"),
        variant: "destructive"
      })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!availableDomains.includes(currentDomain)) {
      setCurrentDomain(availableDomains[0] ?? "")
    }
  }, [availableDomains, currentDomain])

  return (
    <Dialog open={open} onOpenChange={value => {
      setOpen(value)
      if (value && !config) void fetchConfig()
    }}>
      <DialogTrigger asChild>
        <Button className="gap-2">
          <Plus className="w-4 h-4" />
          {t("title")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>
        <div className="min-w-0 space-y-4 py-4">
          {configLoading && <p role="status" className="text-sm text-muted-foreground">{t("configLoading")}</p>}
          {configError && (
            <div role="alert" className="space-y-2">
              <p className="text-sm text-destructive">{t("configFailed")}</p>
              <Button variant="outline" onClick={() => void fetchConfig()} disabled={configLoading}>
                {t("retryConfig")}
              </Button>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Input
              value={emailName}
              onChange={(e) => setEmailName(e.target.value)}
              placeholder={t("namePlaceholder")}
              className="min-w-0 flex-1 basis-40"
            />
            {availableDomains.length > 1 && (
              <Select value={currentDomain} onValueChange={setCurrentDomain}>
                <SelectTrigger className="w-[180px] max-w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {availableDomains.map(d => (
                    <SelectItem key={d} value={d}>@{d}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button
              variant="outline"
              size="icon"
              onClick={generateRandomName}
              type="button"
              aria-label={tCommon("refresh")}
            >
              <RefreshCw className="w-4 h-4" />
            </Button>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
            <Label className="shrink-0 text-muted-foreground">{t("expiryTime")}</Label>
            <RadioGroup
              value={expiryTime}
              onValueChange={setExpiryTime}
              className="grid grid-cols-2 gap-x-4 gap-y-3 sm:flex sm:flex-wrap sm:gap-6"
            >
              {EXPIRY_OPTIONS.map((option, index) => {
                const labels = [t("oneHour"), t("oneDay"), t("threeDays"), t("permanent")]
                return (
                  <div key={option.value} className="flex items-center gap-2">
                    <RadioGroupItem value={option.value.toString()} id={option.value.toString()} />
                    <Label htmlFor={option.value.toString()} className="cursor-pointer text-sm">
                      {labels[index]}
                    </Label>
                  </div>
                )
              })}
            </RadioGroup>
          </div>

          <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
            <span className="shrink-0">{t("domain")}:</span>
            {mailboxName && currentDomain ? (
              <div className="flex items-center gap-2 min-w-0">
                <span className="truncate">{`${mailboxName}@${currentDomain}`}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0"
                  aria-label={tCommon("copy")}
                  onClick={copyEmailAddress}
                >
                  <Copy className="size-4" />
                </Button>
              </div>
            ) : (
              <span className="text-muted-foreground">...</span>
            )}
          </div>
          {config && !configLoading && availableDomains.length === 0 && (
            <p className="text-sm text-muted-foreground" role="status">{t("noDomains")}</p>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)} disabled={loading}>
            {tCommon("cancel")}
          </Button>
          <Button onClick={createEmail} disabled={loading || configLoading || !config || !currentDomain}>
            {loading ? t("creating") : t("create")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
