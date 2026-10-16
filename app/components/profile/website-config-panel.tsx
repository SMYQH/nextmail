"use client"

import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Settings } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { useState, useEffect } from "react"
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
  const [turnstileSecretKey, setTurnstileSecretKey] = useState("")
  const [catchAllDomains, setCatchAllDomains] = useState<Record<string, CatchAllDomainSettings>>({})
  const [showSecretKey, setShowSecretKey] = useState(false)
  const [loading, setLoading] = useState(false)
  const { toast } = useToast()


  useEffect(() => {
    fetchConfig()
  }, [])

  const fetchConfig = async () => {
    const res = await fetch("/api/config")
    if (res.ok) {
      const data = await res.json() as { 
        defaultRole: Exclude<Role, typeof ROLES.EMPEROR>,
        emailDomains: string,
        adminContact: string,
        maxEmails: string,
        turnstile?: {
          enabled: boolean,
          siteKey: string,
          secretKey?: string
        },
        catchAll?: {
          domains: Record<string, CatchAllDomainSettings>
        }
      }
      setDefaultRole(data.defaultRole)
      setEmailDomains(data.emailDomains)
      setAdminContact(data.adminContact)
      setMaxEmails(data.maxEmails || EMAIL_CONFIG.MAX_ACTIVE_EMAILS.toString())
      setTurnstileEnabled(Boolean(data.turnstile?.enabled))
      setTurnstileSiteKey(data.turnstile?.siteKey ?? "")
      setTurnstileSecretKey(data.turnstile?.secretKey ?? "")
      setCatchAllDomains(data.catchAll?.domains ?? {})
    }
  }

  const handleSave = async () => {
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
          maxEmails: maxEmails || EMAIL_CONFIG.MAX_ACTIVE_EMAILS.toString(),
          catchAll: {
            domains: normalizedCatchAllDomains,
          },
          turnstile: {
            enabled: turnstileEnabled,
            siteKey: turnstileSiteKey,
            secretKey: turnstileSecretKey
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
              max="100"
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
                value={turnstileSecretKey}
                onChange={(e) => setTurnstileSecretKey(e.target.value)}
                placeholder={t("turnstile.secretKeyPlaceholder")}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                onClick={() => setShowSecretKey((prev) => !prev)}
              >
                {showSecretKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
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
