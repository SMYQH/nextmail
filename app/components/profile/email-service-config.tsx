"use client"

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Zap, Eye, EyeOff } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { useConfig } from "@/hooks/use-config"

interface DomainConfig {
  enabled: boolean
  apiKey: string
  hasApiKey: boolean
  configured: boolean
}

interface EmailServiceConfig {
  domains: Record<string, DomainConfig>
  roleLimits: {
    duke: number
    knight: number
  }
}

const INITIAL_CONFIG: EmailServiceConfig = {
  domains: {},
  roleLimits: { duke: -1, knight: -1 },
}

export function EmailServiceConfig() {
  const t = useTranslations("profile.emailService")
  const tCard = useTranslations("profile.card")
  const tSend = useTranslations("emails.send")
  const { config: websiteConfig } = useConfig()
  const [config, setConfig] = useState<EmailServiceConfig>(INITIAL_CONFIG)
  const [loading, setLoading] = useState(false)
  const [visibleTokens, setVisibleTokens] = useState<Set<string>>(new Set())
  const { toast } = useToast()

  const fetchConfig = useCallback(async () => {
    try {
      const response = await fetch("/api/config/email-service", { cache: "no-store" })
      if (!response.ok) return
      const data = await response.json() as EmailServiceConfig
      setConfig(data)
    } catch (error) {
      console.error("Failed to fetch email service config:", error)
    }
  }, [])

  useEffect(() => {
    fetchConfig()
  }, [fetchConfig, websiteConfig?.emailDomains])

  const updateDomain = (domain: string, updates: Partial<DomainConfig>) => {
    setConfig((current) => ({
      ...current,
      domains: {
        ...current.domains,
        [domain]: { ...current.domains[domain], ...updates },
      },
    }))
  }

  const handleSave = async () => {
    setLoading(true)
    try {
      const response = await fetch("/api/config/email-service", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domains: Object.fromEntries(
            Object.entries(config.domains).map(([domain, domainConfig]) => [
              domain,
              { enabled: domainConfig.enabled, apiKey: domainConfig.apiKey },
            ]),
          ),
          roleLimits: config.roleLimits,
        }),
      })

      if (!response.ok) {
        const data = await response.json().catch(() => null) as { error?: string } | null
        throw new Error(data?.error || t("saveFailed"))
      }

      await fetchConfig()
      toast({ title: t("saveSuccess"), description: t("saveSuccess") })
    } catch (error) {
      toast({
        title: t("saveFailed"),
        description: error instanceof Error ? error.message : t("saveFailed"),
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fluent-panel p-6">
      <div className="mb-6 flex items-center gap-2">
        <Zap className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-semibold">{t("title")}</h2>
      </div>

      <div className="space-y-6">
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-sm font-medium">{t("domainConfig")}</Label>
            <p className="text-xs text-muted-foreground">{t("domainConfigDescription")}</p>
          </div>

          <div className="hidden grid-cols-[5rem_minmax(8rem,0.8fr)_minmax(0,1.2fr)] gap-3 px-2 text-xs font-medium text-muted-foreground sm:grid">
            <span>{t("enabledColumn")}</span>
            <span>{t("domainColumn")}</span>
            <span>{t("apiKey")}</span>
          </div>

          {Object.entries(config.domains).length > 0 ? (
            <div className="space-y-2">
              {Object.entries(config.domains).map(([domain, domainConfig]) => {
                const tokenVisible = visibleTokens.has(domain)
                return (
                  <div key={domain} className="space-y-2 rounded-md border border-primary/20 p-3">
                    <div className="grid min-w-0 grid-cols-1 items-center gap-3 sm:grid-cols-[5rem_minmax(8rem,0.8fr)_minmax(0,1.2fr)]">
                      <Switch
                        checked={domainConfig.enabled}
                        onCheckedChange={(enabled) => updateDomain(domain, { enabled })}
                        aria-label={t("enableDomain", { domain })}
                        disabled={!domainConfig.configured}
                      />
                      <span className="truncate text-sm font-medium">{domain}</span>
                      <div className="relative min-w-0">
                        <Input
                          type={tokenVisible ? "text" : "password"}
                          value={domainConfig.apiKey}
                          onChange={(event) => updateDomain(domain, { apiKey: event.target.value })}
                          placeholder={t(domainConfig.hasApiKey ? "apiKeyConfigured" : "apiKeyPlaceholder")}
                          aria-label={t("domainApiKey", { domain })}
                          className="w-full min-w-0 pr-10"
                          disabled={!domainConfig.configured}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                          onClick={() => setVisibleTokens((current) => {
                            const next = new Set(current)
                            if (next.has(domain)) next.delete(domain)
                            else next.add(domain)
                            return next
                          })}
                          aria-label={tokenVisible ? t("hideApiKey") : t("showApiKey")}
                          disabled={!domainConfig.configured}
                        >
                          {tokenVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </Button>
                      </div>
                    </div>
                    {!domainConfig.configured && (
                      <p className="text-xs text-destructive">{t("removedDomainWarning")}</p>
                    )}
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
              {t("noDomains")}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label className="text-sm font-medium">{t("roleLimits")}</Label>
          <div className="space-y-4">
            <div className="fluent-info-panel p-4 text-sm">
              <p className="mb-3 flex items-center gap-2 font-semibold text-primary">
                <span className="h-2 w-2 rounded-full bg-blue-500" />
                {t("fixedRoleLimits")}
              </p>
              <div className="space-y-2 text-foreground">
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                  <span><strong>{tCard("roles.EMPEROR")}</strong> - {t("emperorLimit")}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
                  <span><strong>{tCard("roles.CIVILIAN")}</strong> - {t("civilianLimit")}</span>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-orange-500" />
                <p className="text-sm font-medium text-foreground">{t("configRoleLabel")}</p>
              </div>
              {[
                { value: "duke", label: tCard("roles.DUKE"), key: "duke" as const },
                { value: "knight", label: tCard("roles.KNIGHT"), key: "knight" as const },
              ].map((role) => {
                const isDisabled = config.roleLimits[role.key] === -1
                const isEnabled = !isDisabled
                return (
                  <div
                    key={role.value}
                    className={`group relative rounded-lg border p-4 ${
                      isEnabled
                        ? "border-primary/30 bg-primary/5 shadow-xs"
                        : "border-border bg-background/25 hover:border-primary/20 hover:shadow-xs"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex items-center gap-4">
                        <Checkbox
                          id={`role-${role.value}`}
                          checked={isEnabled}
                          onChange={(checked: boolean) => setConfig((current) => ({
                            ...current,
                            roleLimits: {
                              ...current.roleLimits,
                              [role.key]: checked ? 0 : -1,
                            },
                          }))}
                        />
                        <div>
                          <Label
                            htmlFor={`role-${role.value}`}
                            className="flex cursor-pointer select-none items-center gap-2 text-base font-semibold"
                          >
                            <span className="text-2xl">{role.value === "duke" ? "🏰" : "⚔️"}</span>
                            {role.label}
                          </Label>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {isEnabled ? t("enabled") : t("disabled")}
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        <Label className="mb-1 block text-xs font-medium text-muted-foreground">
                          {t("dailyLimit")}
                        </Label>
                        <div className="flex items-center justify-end gap-2">
                          <Input
                            type="number"
                            min="0"
                            value={Math.max(0, config.roleLimits[role.key])}
                            onChange={(event) => {
                              const parsed = Number.parseInt(event.target.value, 10)
                              setConfig((current) => ({
                                ...current,
                                roleLimits: {
                                  ...current.roleLimits,
                                  [role.key]: Number.isFinite(parsed) ? Math.max(0, parsed) : 0,
                                },
                              }))
                            }}
                            className="h-9 w-20 text-center text-sm font-medium"
                            disabled={isDisabled}
                          />
                          <span className="whitespace-nowrap text-xs text-muted-foreground">
                            {tSend("dailyLimitUnit")}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">0 = {t("unlimited")}</p>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        <Button onClick={handleSave} disabled={loading} className="w-full">
          {loading ? t("saving") : t("save")}
        </Button>
      </div>
    </div>
  )
}
