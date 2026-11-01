"use client"

import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Settings } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { useState, useEffect, useCallback } from "react"
import { ROLES } from "@/lib/permissions"
import type { Role } from "@/lib/permissions"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Eye, EyeOff } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { EMAIL_CONFIG } from "@/config"
import { normalizeMailboxName } from "@/lib/catch-all"
import { normalizeEmailDomains } from "@/lib/email-domains"
import { useConfigStore } from "@/hooks/use-config"
import { parsePositiveSafeInteger } from "@/lib/max-emails"

interface CatchAllDomainSettings {
  enabled: boolean
  showAlways: boolean
  mailboxName: string
}

const DEFAULT_CATCH_ALL_DOMAIN_SETTINGS: CatchAllDomainSettings = {
  enabled: false,
  showAlways: true,
  mailboxName: "",
}

export function WebsiteConfigPanel() {
  const t = useTranslations("profile.website")
  const tCard = useTranslations("profile.card")
  const [defaultRole, setDefaultRole] = useState<string>("")
  const [emailDomains, setEmailDomains] = useState<string>("")
  const [adminContact, setAdminContact] = useState<string>("")
  const [maxEmails, setMaxEmails] = useState<string>(EMAIL_CONFIG.MAX_ACTIVE_EMAILS.toString())
  const [turnstileEnabled, setTurnstileEnabled] = useState(false)
  const [turnstileSiteKey, setTurnstileSiteKey] = useState("")
  // The stored secret stays on the server: the browser only learns whether one
  // is configured and keeps any replacement the operator types.
  const [turnstileHasSecret, setTurnstileHasSecret] = useState(false)
  const [turnstileSecretInput, setTurnstileSecretInput] = useState("")
  const [catchAllDomains, setCatchAllDomains] = useState<Record<string, CatchAllDomainSettings>>({})
  const [showSecretKey, setShowSecretKey] = useState(false)
  const [loading, setLoading] = useState(false)
  const { toast } = useToast()


  const fetchConfig = useCallback(async () => {
    const res = await fetch("/api/config", { cache: "no-store" })
    if (!res.ok) return null

    return await res.json() as {
      defaultRole: Exclude<Role, typeof ROLES.EMPEROR>,
      emailDomains: string,
      adminContact: string,
      maxEmails: string,
      turnstile?: {
        enabled: boolean,
        siteKey: string,
        hasSecret?: boolean
      },
      catchAll?: {
        domains: Record<string, CatchAllDomainSettings>
      }
    }
  }, [])

  useEffect(() => {
    let active = true
    void fetchConfig().then((data) => {
      if (!active || !data) return
      setDefaultRole(data.defaultRole)
      setEmailDomains(data.emailDomains)
      setAdminContact(data.adminContact)
      setMaxEmails(data.maxEmails || EMAIL_CONFIG.MAX_ACTIVE_EMAILS.toString())
      setTurnstileEnabled(Boolean(data.turnstile?.enabled))
      setTurnstileSiteKey(data.turnstile?.siteKey ?? "")
      setTurnstileHasSecret(Boolean(data.turnstile?.hasSecret))
      setCatchAllDomains(data.catchAll?.domains ?? {})
    })

    return () => {
      active = false
    }
  }, [fetchConfig])

  const handleSave = async () => {
    const parsedMaxEmails = parsePositiveSafeInteger(maxEmails)
    if (parsedMaxEmails === null) {
      toast({
        title: t("saveFailed"),
        description: t("maxEmailsInvalid"),
        variant: "destructive",
      })
      return
    }

    setLoading(true)
    let failureDescription = t("saveFailed")
    try {
      const configuredDomains = normalizeEmailDomains(emailDomains)
      const normalizedCatchAllDomains = configuredDomains.reduce<Record<string, CatchAllDomainSettings>>((config, domain) => {
        const domainSettings = catchAllDomains[domain] ?? DEFAULT_CATCH_ALL_DOMAIN_SETTINGS
        config[domain] = {
          ...domainSettings,
          mailboxName: normalizeMailboxName(domainSettings.mailboxName),
        }
        return config
      }, {})

      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          defaultRole, 
          emailDomains,
          adminContact,
          maxEmails: String(parsedMaxEmails),
          catchAll: {
            domains: normalizedCatchAllDomains,
          },
          turnstile: {
            enabled: turnstileEnabled,
            siteKey: turnstileSiteKey,
            secretKey: turnstileSecretInput
          }
        }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => null) as { code?: string } | null
        switch (data?.code) {
          case "CATCH_ALL_MAILBOX_NAME_REQUIRED":
            failureDescription = t("catchAll.mailboxNameRequired")
            break
          case "INVALID_CATCH_ALL_MAILBOX_NAME":
            failureDescription = t("catchAll.invalidMailboxName")
            break
          case "CATCH_ALL_ADDRESS_OCCUPIED":
            failureDescription = t("catchAll.addressOccupied")
            break
        }
        throw new Error("Configuration save failed")
      }

      setEmailDomains(configuredDomains.join(","))
      setCatchAllDomains(normalizedCatchAllDomains)
      if (turnstileSecretInput.trim()) setTurnstileHasSecret(true)
      setTurnstileSecretInput("")
      await useConfigStore.getState().fetch()

      toast({
        title: t("saveSuccess"),
        description: t("saveSuccess"),
      })
    } catch {
      toast({
        title: t("saveFailed"),
        description: failureDescription,
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fluent-panel p-6">
      <div className="flex items-center gap-2 mb-6">
        <Settings className="w-5 h-5 text-primary" />
        <h2 className="text-lg font-semibold">{t("title")}</h2>
      </div>

      <div className="space-y-4">
        <div className="flex items-center gap-4">
          <span className="text-sm">{t("defaultRole")}:</span>
          <Select value={defaultRole} onValueChange={setDefaultRole}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ROLES.DUKE}>{tCard("roles.DUKE")}</SelectItem>
              <SelectItem value={ROLES.KNIGHT}>{tCard("roles.KNIGHT")}</SelectItem>
              <SelectItem value={ROLES.CIVILIAN}>{tCard("roles.CIVILIAN")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-4">
          <span className="text-sm">{t("emailDomains")}:</span>
          <div className="flex-1">
            <Input 
              value={emailDomains}
              onChange={(e) => setEmailDomains(e.target.value)}
              placeholder={t("emailDomainsPlaceholder")}
            />
          </div>
        </div>

        <div className="flex items-center gap-4">
          <span className="text-sm">{t("adminContact")}:</span>
          <div className="flex-1">
            <Input 
              value={adminContact}
              onChange={(e) => setAdminContact(e.target.value)}
              placeholder={t("adminContactPlaceholder")}
            />
          </div>
        </div>

        <div className="flex items-center gap-4">
          <span className="text-sm">{t("maxEmails")}:</span>
          <div className="flex-1">
            <Input 
              type="number"
              min="1"
              max={Number.MAX_SAFE_INTEGER}
              step="1"
              value={maxEmails}
              onChange={(e) => setMaxEmails(e.target.value)}
              placeholder={`${EMAIL_CONFIG.MAX_ACTIVE_EMAILS}`}
            />
          </div>
        </div>

        <div className="space-y-4 rounded-lg border border-dashed border-primary/40 p-4">
          <div className="space-y-1">
            <Label className="text-sm font-medium">{t("catchAll.title")}</Label>
            <p className="text-xs text-muted-foreground">{t("catchAll.description")}</p>
          </div>

          <div className="space-y-4">
            {normalizeEmailDomains(emailDomains).map((domain, index) => {
              const domainSettings = catchAllDomains[domain] ?? DEFAULT_CATCH_ALL_DOMAIN_SETTINGS
              const controlId = `catch-all-${index}`
              const updateDomainSettings = (updates: Partial<CatchAllDomainSettings>) => {
                setCatchAllDomains((current) => ({
                  ...current,
                  [domain]: {
                    ...DEFAULT_CATCH_ALL_DOMAIN_SETTINGS,
                    ...current[domain],
                    ...updates,
                  },
                }))
              }

              return (
                <fieldset key={domain} className="min-w-0 space-y-4 rounded-md border border-primary/20 p-3">
                  <legend className="break-all px-1 text-sm font-medium">{domain}</legend>
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <Label htmlFor={`${controlId}-enabled`}>{t("catchAll.enabledLabel")}</Label>
                      <p id={`${controlId}-enabled-description`} className="text-xs text-muted-foreground">
                        {t("catchAll.enabledDescription", { domain })}
                      </p>
                    </div>
                    <Switch
                      id={`${controlId}-enabled`}
                      checked={domainSettings.enabled}
                      onCheckedChange={(enabled) => updateDomainSettings({ enabled })}
                      aria-label={t("catchAll.enableDomain", { domain })}
                      aria-describedby={`${controlId}-enabled-description`}
                      className="shrink-0"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`${controlId}-mailbox`}>{t("catchAll.mailboxLabel")}</Label>
                    <div className="flex min-w-0 items-center rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
                      <Input
                        id={`${controlId}-mailbox`}
                        value={domainSettings.mailboxName}
                        onChange={(event) => updateDomainSettings({ mailboxName: event.target.value })}
                        placeholder={t("catchAll.mailboxNamePlaceholder")}
                        aria-label={t("catchAll.mailboxName", { domain })}
                        className="min-w-0 w-0 flex-1 border-0 focus-visible:ring-0 focus-visible:ring-offset-0"
                      />
                      <span className="max-w-[60%] shrink-0 break-all pr-3 text-sm text-muted-foreground">@{domain}</span>
                    </div>
                  </div>
                  <div className="flex items-start justify-between gap-4 border-t pt-3">
                    <div className="space-y-1">
                      <Label htmlFor={`${controlId}-visible`}>{t("catchAll.showWhenDisabledLabel")}</Label>
                      <p id={`${controlId}-visible-description`} className="text-xs text-muted-foreground">
                        {t("catchAll.showWhenDisabledDescription")}
                      </p>
                    </div>
                    <Switch
                      id={`${controlId}-visible`}
                      checked={domainSettings.showAlways}
                      onCheckedChange={(showAlways) => updateDomainSettings({ showAlways })}
                      aria-label={t("catchAll.showWhenDisabledDomain", { domain })}
                      aria-describedby={`${controlId}-visible-description`}
                      className="shrink-0"
                    />
                  </div>
                </fieldset>
              )
            })}
          </div>
        </div>

        <div className="space-y-4 rounded-lg border border-dashed border-primary/40 p-4">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <Label htmlFor="turnstile-enabled" className="text-sm font-medium">
                {t("turnstile.enable")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("turnstile.enableDescription")}
              </p>
            </div>
            <Switch
              id="turnstile-enabled"
              checked={turnstileEnabled}
              onCheckedChange={setTurnstileEnabled}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="turnstile-site-key" className="text-sm font-medium">
              {t("turnstile.siteKey")}
            </Label>
            <Input
              id="turnstile-site-key"
              value={turnstileSiteKey}
              onChange={(e) => setTurnstileSiteKey(e.target.value)}
              placeholder={t("turnstile.siteKeyPlaceholder")}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="turnstile-secret-key" className="text-sm font-medium">
              {t("turnstile.secretKey")}
            </Label>
            <div className="relative">
              <Input
                id="turnstile-secret-key"
                type={showSecretKey ? "text" : "password"}
                value={turnstileSecretInput}
                onChange={(e) => setTurnstileSecretInput(e.target.value)}
                placeholder={t(turnstileHasSecret ? "turnstile.secretKeyConfigured" : "turnstile.secretKeyPlaceholder")}
                autoComplete="off"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                aria-label={showSecretKey ? t("turnstile.hideSecretKey") : t("turnstile.showSecretKey")}
                onClick={() => setShowSecretKey((prev) => !prev)}
              >
                {showSecretKey ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t(turnstileHasSecret ? "turnstile.secretKeyStatusConfigured" : "turnstile.secretKeyStatusNotConfigured")}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("turnstile.secretKeyDescription")}
            </p>
          </div>
        </div>

        <Button 
          onClick={handleSave}
          disabled={loading}
          className="w-full"
        >
          {t("save")}
        </Button>
      </div>
    </div>
  )
} 
