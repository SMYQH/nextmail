/* eslint-disable @typescript-eslint/no-unused-vars */
"use client"

import { useState, useEffect } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { useToast } from "@/components/ui/use-toast"
import { Loader2, Send, ChevronDown, ChevronUp } from "lucide-react"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

export function WebhookConfig() {
  const t = useTranslations("profile.webhook")
  const tCommon = useTranslations("common.actions")
  const tMessages = useTranslations("emails.messages")
  const tApiKey = useTranslations("profile.apiKey")
  const [enabled, setEnabled] = useState(false)
  const [url, setUrl] = useState("")
  const [loading, setLoading] = useState(false)
  const [testing, setTesting] = useState(false)
  const [showDocs, setShowDocs] = useState(false)
  const [initialLoading, setInitialLoading] = useState(true)
  const [setupError, setSetupError] = useState<string>()
  const { toast } = useToast()

  const errorMessage = (code: unknown, fallback: "saveFailed" | "testFailed") => {
    if (typeof code === "string" && ["setupRequired", "hostNotAllowed", "invalidUrl", "saveBeforeTest"].includes(code)) return t(code)
    return t(fallback)
  }

  useEffect(() => {
    fetch("/api/webhook")
      .then(res => res.json() as Promise<{ enabled: boolean; url: string; setupError?: string }>)
      .then(data => {
        setEnabled(data.enabled)
        setUrl(data.url)
        setSetupError(data.setupError)
      })
      .catch(console.error)
      .finally(() => setInitialLoading(false))
  }, [])

  if (initialLoading) {
    return (
      <div className="text-center">
        <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
          <Loader2 className="w-6 h-6 text-primary animate-spin" />
        </div>
        <div>
          <p className="text-sm text-muted-foreground">{tMessages("loading")}</p>
        </div>
      </div>
    )
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!url) return

    setLoading(true)
    try {
      const res = await fetch("/api/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, enabled })
      })

      if (!res.ok) {
        const data = await res.json() as { error?: string }
        throw new Error(errorMessage(data.error, "saveFailed"))
      }
      setSetupError(undefined)

      toast({
        title: t("saveSuccess"),
        description: t("saveSuccess")
      })
    } catch (error) {
      toast({
        title: t("saveFailed"),
        description: error instanceof Error ? error.message : t("saveFailed"),
        variant: "destructive"
      })
    } finally {
      setLoading(false)
    }
  }

  const handleTest = async () => {
    if (!url) return

    setTesting(true)
    try {
      const res = await fetch("/api/webhook/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url })
      })

      if (!res.ok) {
        const data = await res.json() as { error?: string }
        throw new Error(errorMessage(data.error, "testFailed"))
      }

      toast({
        title: t("testSuccess"),
        description: t("testSuccess")
      })
    } catch (error) {
      toast({
        title: t("testFailed"),
        description: error instanceof Error ? error.message : t("testFailed"),
        variant: "destructive"
      })
    } finally {
      setTesting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {setupError && <p role="alert" className="text-sm text-destructive">{errorMessage(setupError, "saveFailed")}</p>}
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label>{t("enable")}</Label>
          <div className="text-sm text-muted-foreground">
            {t("description")}
          </div>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
        />
      </div>

      {enabled && (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="webhook-url">{t("url")}</Label>
            <div className="flex gap-2">
              <Input
                id="webhook-url"
                placeholder={t("urlPlaceholder")}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                type="url"
                required
              />
              <Button type="submit" disabled={loading} className="shrink-0">
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  tCommon("save")
                )}
              </Button>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleTest}
                      disabled={testing || !url}
                    >
                      {testing ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Send className="w-4 h-4" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{t("test")}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("description2")}
            </p>
          </div>

          <div className="space-y-2">
            <button
              type="button"
              className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setShowDocs(!showDocs)}
            >
              {showDocs ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              {t("description3")}
            </button>

            {showDocs && (
              <div className="rounded-md bg-muted p-4 text-sm space-y-3">
                <p>{t("docs.intro")}</p>
                <pre className="bg-background p-2 rounded-sm text-xs">
                  Content-Type: application/json{'\n'}
                  X-Webhook-Event: new_message
                </pre>

                <p>{t("docs.exampleBody")}</p>
                <pre className="bg-background p-2 rounded-sm text-xs overflow-auto">
                  {`{
  "emailId": "email-uuid",
  "messageId": "message-uuid",
  "fromAddress": "sender@nextmail.pages.dev",
  "subject": "${t("docs.subject")}",
  "content": "${t("docs.content")}",
  "html": "${t("docs.html")}",
  "receivedAt": "2024-01-01T12:00:00.000Z",
  "toAddress": "your-email@${window.location.host}"
}`}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}
      {!enabled && url && <Button type="submit" disabled={loading}>{tCommon("save")}</Button>}
    </form>
  )
}
