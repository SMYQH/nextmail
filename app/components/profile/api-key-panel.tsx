"use client"

import { useCallback, useState, useEffect, useId, useRef } from "react"
import { useLocale, useTranslations } from "next-intl"
import { SharedDateTime } from "@/components/emails/shared-date-time"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Key, Plus, Loader2, Copy, Trash2, ChevronDown, ChevronUp } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
  DialogDescription,
  DialogClose,
} from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { useCopy } from "@/hooks/use-copy"
import { useRolePermission } from "@/hooks/use-role-permission"
import { PERMISSIONS } from "@/lib/permissions"
import { useConfig } from "@/hooks/use-config"
import { LatestRequestGate } from "@/lib/latest-request-gate"
import { EmptyState } from "@/components/ui/empty-state"

type ApiKey = {
  id: string
  name: string
  key: string
  createdAt: string
  expiresAt: string | null
  enabled: boolean
}

export function ApiKeyPanel() {
  const locale = useLocale()
  const t = useTranslations("profile.apiKey")
  const tCommon = useTranslations("common.actions")
  const tNoPermission = useTranslations("emails.noPermission")
  const tMessages = useTranslations("emails.messages")
  const tPagination = useTranslations("common.pagination")
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const apiKeysRef = useRef<ApiKey[]>([])
  const nextCursorRef = useRef<string | null>(null)
  const loadedApiKeyListRef = useRef(false)
  const deletedApiKeyIdsRef = useRef(new Set<string>())
  const toggleRefs = useRef(new Map<string, HTMLButtonElement>())
  const restoreToggleFocusRef = useRef<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [newKeyName, setNewKeyName] = useState("")
  const [newKey, setNewKey] = useState<string | null>(null)
  const [createError, setCreateError] = useState<"nameExists" | "createFailed" | null>(null)
  const nameInputId = useId()
  const nameInputRef = useRef<HTMLInputElement>(null)
  const creationGateRef = useRef(new LatestRequestGate())
  const listGateRef = useRef(new LatestRequestGate())
  const mountedRef = useRef(false)
  const pendingKeysRef = useRef(new Set<string>())
  const creatingRef = useRef(false)
  const [pendingKeys, setPendingKeys] = useState(new Set<string>())
  const { toast } = useToast()
  const { copyToClipboard } = useCopy()
  const [showExamples, setShowExamples] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const { checkPermission } = useRolePermission()
  const canManageApiKey = checkPermission(PERMISSIONS.MANAGE_API_KEY)

  useEffect(() => {
    mountedRef.current = true
    const gate = creationGateRef.current
    const listGate = listGateRef.current
    return () => {
      mountedRef.current = false
      gate.invalidate()
      listGate.invalidate()
    }
  }, [])

  const commitApiKeys = useCallback((keys: ApiKey[]) => {
    apiKeysRef.current = keys
    setApiKeys(keys)
  }, [])

  const commitNextCursor = useCallback((cursor: string | null) => {
    nextCursorRef.current = cursor
    setNextCursor(cursor)
  }, [])

  const invalidateApiKeyListRequests = useCallback(() => {
    listGateRef.current.invalidate()
    setIsLoading(false)
    setLoadingMore(false)
  }, [])

  useEffect(() => {
    if (createError && !loading) nameInputRef.current?.focus()
  }, [createError, loading])

  useEffect(() => {
    const id = restoreToggleFocusRef.current
    if (!id || pendingKeys.has(id)) return

    restoreToggleFocusRef.current = null
    const activeElement = document.activeElement
    if (activeElement === document.body || activeElement === null) {
      toggleRefs.current.get(id)?.focus()
    }
  }, [pendingKeys])

  const requestApiKeyPage = useCallback(async (cursor?: string) => {
    const res = await fetch(cursor !== undefined ? `/api/api-keys?cursor=${encodeURIComponent(cursor)}` : "/api/api-keys")
    if (!res.ok) throw new Error(t("loadFailed"))
    return await res.json() as { apiKeys: ApiKey[]; nextCursor?: string | null }
  }, [t])

  const applyApiKeyPage = useCallback((data: { apiKeys: ApiKey[]; nextCursor?: string | null }, cursor?: string) => {
    const receivedKeys = data.apiKeys.filter(key => !deletedApiKeyIdsRef.current.has(key.id))
    const currentKeys = apiKeysRef.current
    const currentIds = new Set(currentKeys.map(key => key.id))
    const receivedById = new Map(receivedKeys.map(key => [key.id, key]))
    const refreshedKeys = currentKeys.map(key => receivedById.get(key.id) ?? key)
    if (cursor !== undefined) {
      commitApiKeys([...refreshedKeys, ...receivedKeys.filter(key => !currentIds.has(key.id))])
      commitNextCursor(data.nextCursor ?? null)
    } else if (!loadedApiKeyListRef.current || currentKeys.length === 0) {
      commitApiKeys(receivedKeys)
      commitNextCursor(data.nextCursor ?? null)
    } else {
      // A first-page refresh may discover newly created keys, but replacing
      // the list would discard older loaded pages and move the pagination
      // boundary. Merge refreshed values by ID, prepend new rows, and keep
      // the older loaded rows and cursor intact. The request gate rejects
      // snapshots that preceded a local mutation.
      commitApiKeys([...receivedKeys.filter(key => !currentIds.has(key.id)), ...refreshedKeys])
    }
    loadedApiKeyListRef.current = true
  }, [commitApiKeys, commitNextCursor])

  const fetchApiKeys = useCallback(async (cursor?: string) => {
    const ticket = listGateRef.current.begin("api-key:list")
    try {
      const data = await requestApiKeyPage(cursor)
      if (!ticket.isCurrent()) return
      applyApiKeyPage(data, cursor)
    } catch (error) {
      if (!ticket.isCurrent()) return
      console.error(error)
      toast({
        title: cursor !== undefined ? tPagination("loadFailed") : t("loadFailed"),
        description: cursor !== undefined ? tPagination("loadFailed") : t("loadFailed"),
        variant: "destructive"
      })
    } finally {
      if (ticket.isCurrent()) {
        setIsLoading(false)
        setLoadingMore(false)
      }
    }
  }, [applyApiKeyPage, requestApiKeyPage, t, tPagination, toast])

  useEffect(() => {
    if (!canManageApiKey) return

    const ticket = listGateRef.current.begin("api-key:list")
    void requestApiKeyPage()
      .then(data => {
        if (ticket.isCurrent()) applyApiKeyPage(data)
      })
      .catch(error => {
        if (!ticket.isCurrent()) return
        console.error(error)
        toast({
          title: t("loadFailed"),
          description: t("loadFailed"),
          variant: "destructive"
        })
      })
      .finally(() => {
        if (ticket.isCurrent()) {
          setIsLoading(false)
          setLoadingMore(false)
        }
      })
  }, [applyApiKeyPage, canManageApiKey, requestApiKeyPage, t, toast])

  const { config } = useConfig()
  // The example uses a domain this deployment actually serves mail for.
  const exampleDomain = config?.availableEmailDomains?.[0] || "example.com"

  const createApiKey = async () => {
    if (loading || !newKeyName.trim()) return
    // The ref also blocks a repeated submit before React renders the disabled input.
    if (creatingRef.current) return
    creatingRef.current = true

    const ticket = creationGateRef.current.begin("api-key:create")
    setCreateError(null)
    setLoading(true)
    try {
      const res = await fetch("/api/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newKeyName })
      })

      if (!res.ok) {
        const body = await res.json().catch(() => null) as { code?: unknown } | null
        if (!ticket.isCurrent()) return
        setCreateError(res.status === 409 && body?.code === "API_KEY_NAME_EXISTS" ? "nameExists" : "createFailed")
        return
      }

      const data = await res.json() as { key: string }
      // Closing the dialog does not cancel a server-side creation.
      if (mountedRef.current) {
        invalidateApiKeyListRequests()
        void fetchApiKeys()
      }
      if (!ticket.isCurrent()) return
      setNewKey(data.key)
    } catch {
      if (ticket.isCurrent()) setCreateError("createFailed")
    } finally {
      creatingRef.current = false
      if (ticket.isCurrent()) setLoading(false)
    }
  }

  const handleDialogClose = () => {
    creationGateRef.current.invalidate()
    creatingRef.current = false
    setCreateDialogOpen(false)
    setLoading(false)
    setNewKeyName("")
    setNewKey(null)
    setCreateError(null)
  }

  const beginKeyMutation = (id: string) => {
    // The ref also blocks repeated actions before React renders disabled controls.
    if (pendingKeysRef.current.has(id)) return false
    if (typeof document !== "undefined" && document.activeElement === toggleRefs.current.get(id)) {
      restoreToggleFocusRef.current = id
    }
    pendingKeysRef.current.add(id)
    setPendingKeys(new Set(pendingKeysRef.current))
    invalidateApiKeyListRequests()
    return true
  }

  const finishKeyMutation = (id: string) => {
    pendingKeysRef.current.delete(id)
    if (mountedRef.current) {
      setPendingKeys(new Set(pendingKeysRef.current))
    }
  }

  const toggleApiKey = async (id: string, enabled: boolean) => {
    if (!beginKeyMutation(id)) return
    try {
      const res = await fetch(`/api/api-keys/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled })
      })

      if (!res.ok) throw new Error(t("updateFailed"))
      if (!mountedRef.current) return

      invalidateApiKeyListRequests()
      commitApiKeys(apiKeysRef.current.map(key => key.id === id ? { ...key, enabled } : key))
      // Reconcile with the server while retaining every loaded page and cursor.
      void fetchApiKeys()
    } catch (error) {
      if (!mountedRef.current) return
      console.error(error)
      toast({
        title: t("updateFailed"),
        description: t("updateFailed"),
        variant: "destructive"
      })
    } finally {
      finishKeyMutation(id)
    }
  }

  const deleteApiKey = async (id: string) => {
    if (!beginKeyMutation(id)) return
    try {
      const res = await fetch(`/api/api-keys/${id}`, {
        method: "DELETE"
      })

      if (!res.ok) throw new Error(t("deleteFailed"))
      if (!mountedRef.current) return

      invalidateApiKeyListRequests()
      deletedApiKeyIdsRef.current.add(id)
      commitApiKeys(apiKeysRef.current.filter(key => key.id !== id))
      void fetchApiKeys()
      toast({
        title: t("deleteSuccess"),
        description: t("deleteSuccess")
      })
    } catch (error) {
      if (!mountedRef.current) return
      console.error(error)
      toast({
        title: t("deleteFailed"),
        description: t("deleteFailed"),
        variant: "destructive"
      })
    } finally {
      finishKeyMutation(id)
    }
  }

  return (
    <div className="fluent-panel p-6 space-y-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <Key className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">{t("title")}</h2>
        </div>
        {
          canManageApiKey && (
            <Dialog open={createDialogOpen} onOpenChange={(open) => {
              if (open) setCreateDialogOpen(true)
              else handleDialogClose()
            }}>
              <DialogTrigger asChild>
                <Button className="gap-2">
                  <Plus className="w-4 h-4" />
                  {t("create")}
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>
                    {newKey ? t("createSuccess") : t("create")}
                  </DialogTitle>
                  {newKey && (
                  <DialogDescription className="text-muted-foreground">
                      {t("keyVisibleInList")}
                    </DialogDescription>
                  )}
                </DialogHeader>

                <form
                  className="grid gap-5"
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (!newKey) void createApiKey()
                  }}
                >
                  {!newKey ? (
                    <div className="space-y-4 py-4">
                      <div className="space-y-2">
                        <Label htmlFor={nameInputId}>{t("name")}</Label>
                        <Input
                          id={nameInputId}
                          ref={nameInputRef}
                          value={newKeyName}
                          onChange={(e) => {
                            setNewKeyName(e.target.value)
                            setCreateError(null)
                          }}
                          placeholder={t("namePlaceholder")}
                          disabled={loading}
                          aria-invalid={createError === "nameExists" || undefined}
                          aria-describedby={createError ? `${nameInputId}-error` : undefined}
                        />
                        {createError && (
                          <p id={`${nameInputId}-error`} role="alert" className="text-sm text-destructive dark:text-red-400">
                            {t(createError)}
                          </p>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-4 py-4">
                      <div className="space-y-2">
                        <Label htmlFor={`${nameInputId}-value`}>{t("key")}</Label>
                        <div className="flex gap-2">
                          <Input
                            id={`${nameInputId}-value`}
                            value={newKey}
                            readOnly
                            className="font-mono text-sm"
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            aria-label={t("copy")}
                            onClick={() => copyToClipboard(newKey)}
                          >
                            <Copy className="w-4 h-4" aria-hidden="true" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}

                  <DialogFooter className="gap-2 sm:gap-0">
                    <DialogClose asChild>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={loading}
                      >
                        {newKey ? tCommon("ok") : tCommon("cancel")}
                      </Button>
                    </DialogClose>
                    {!newKey && (
                      <Button
                        type="submit"
                        disabled={loading || !newKeyName.trim()}
                        aria-label={t("create")}
                        aria-busy={loading}
                        className="gap-2"
                      >
                        <Loader2 className={`w-4 h-4 shrink-0 ${loading ? "animate-spin" : "invisible"}`} aria-hidden="true" />
                        {t("create")}
                      </Button>
                    )}
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          )
        }
      </div>

      {
        !canManageApiKey ? (
          <div className="text-center text-muted-foreground py-8">
            <p>{tNoPermission("needPermission")}</p>
            <p className="mt-2">{tNoPermission("contactAdmin")}</p>
            {
              config?.adminContact && (
                <p className="mt-2">{tNoPermission("adminContact")}: {config.adminContact}</p>
              )
            }
          </div>
        ) : (
          <div className="space-y-4">
            {isLoading ? (
              <div className="text-center py-8 space-y-3">
                <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
                  <Loader2 className="w-6 h-6 text-primary animate-spin" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">{tMessages("loading")}</p>
                </div>
              </div>
            ) : apiKeys.length === 0 ? (
              <EmptyState
                icon={<Key className="w-6 h-6 text-primary" aria-hidden="true" />}
                message={t("noKeys")}
                description={t("description")}
              />
            ) : (
              <>
                {apiKeys.map((key) => (
                  <div
                    key={key.id}
                    className="flex items-center justify-between gap-4 p-4 rounded-lg border bg-card"
                    aria-busy={pendingKeys.has(key.id)}
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="font-medium break-words">{key.name}</div>
                      <div className="text-sm text-muted-foreground">
                        {t("createdAt")}: <SharedDateTime value={key.createdAt} locale={locale} />
                      </div>
                      <div className="flex min-w-0 items-center gap-2 pt-1">
                        <code className="min-w-0 flex-1 break-all font-mono text-xs text-muted-foreground">{key.key}</code>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={t("copyKey", { name: key.name })}
                          onClick={() => copyToClipboard(key.key)}
                        >
                          <Copy className="w-4 h-4" aria-hidden="true" />
                        </Button>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Switch
                        ref={(element) => {
                          if (element) toggleRefs.current.set(key.id, element)
                          else toggleRefs.current.delete(key.id)
                        }}
                        checked={key.enabled}
                        disabled={pendingKeys.has(key.id)}
                        aria-label={t("toggleKey", { name: key.name })}
                        onCheckedChange={(checked) => toggleApiKey(key.id, checked)}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={pendingKeys.has(key.id)}
                        aria-label={t("deleteKey", { name: key.name })}
                        onClick={() => deleteApiKey(key.id)}
                      >
                        <Trash2 className="w-4 h-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                ))}

                {nextCursor && (
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    disabled={loadingMore || loading}
                    aria-busy={loadingMore}
                    onClick={() => {
                      const cursor = nextCursorRef.current
                      if (cursor !== null) {
                        setLoadingMore(true)
                        void fetchApiKeys(cursor)
                      }
                    }}
                  >
                    {tPagination("loadMore")}
                  </Button>
                )}

                <div className="mt-8 space-y-4">
                  <button
                    type="button"
                    className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => setShowExamples(!showExamples)}
                  >
                    {showExamples ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    {t("viewDocs")}
                  </button>

                  {showExamples && (
                    <div className="rounded-lg border bg-card p-4 space-y-4">
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="text-sm font-medium">{t("docs.getConfig")}</div>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t("copy")}
                            onClick={() => copyToClipboard(
                              `curl ${window.location.protocol}//${window.location.host}/api/config \\
  -H "X-API-Key: YOUR_API_KEY"`
                            )}
                          >
                            <Copy className="w-4 h-4" aria-hidden="true" />
                          </Button>
                        </div>
                        <pre className="text-xs bg-muted/50 rounded-lg p-4 overflow-x-auto">
                          {`curl ${window.location.protocol}//${window.location.host}/api/config \\
  -H "X-API-Key: YOUR_API_KEY"`}
                        </pre>
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="text-sm font-medium">{t("docs.generateEmail")}</div>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t("copy")}
                            onClick={() => copyToClipboard(
                              `curl -X POST ${window.location.protocol}//${window.location.host}/api/emails/generate \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "test",
    "expiryTime": 3600000,
    "domain": "${exampleDomain}"
  }'`
                            )}
                          >
                            <Copy className="w-4 h-4" aria-hidden="true" />
                          </Button>
                        </div>
                        <pre className="text-xs bg-muted/50 rounded-lg p-4 overflow-x-auto">
                          {`curl -X POST ${window.location.protocol}//${window.location.host}/api/emails/generate \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "test",
    "expiryTime": 3600000,
    "domain": "${exampleDomain}"
  }'`}
                        </pre>
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="text-sm font-medium">{t("docs.getEmails")}</div>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t("copy")}
                            onClick={() => copyToClipboard(
                              `curl ${window.location.protocol}//${window.location.host}/api/emails?cursor=CURSOR \\
  -H "X-API-Key: YOUR_API_KEY"`
                            )}
                          >
                            <Copy className="w-4 h-4" aria-hidden="true" />
                          </Button>
                        </div>
                        <pre className="text-xs bg-muted/50 rounded-lg p-4 overflow-x-auto">
                          {`curl ${window.location.protocol}//${window.location.host}/api/emails?cursor=CURSOR \\
  -H "X-API-Key: YOUR_API_KEY"`}
                        </pre>
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="text-sm font-medium">{t("docs.getMessages")}</div>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t("copy")}
                            onClick={() => copyToClipboard(
                              `curl ${window.location.protocol}//${window.location.host}/api/emails/{emailId}?cursor=CURSOR \\
  -H "X-API-Key: YOUR_API_KEY"`
                            )}
                          >
                            <Copy className="w-4 h-4" aria-hidden="true" />
                          </Button>
                        </div>
                        <pre className="text-xs bg-muted/50 rounded-lg p-4 overflow-x-auto">
                          {`curl ${window.location.protocol}//${window.location.host}/api/emails/{emailId}?cursor=CURSOR \\
  -H "X-API-Key: YOUR_API_KEY"`}
                        </pre>
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="text-sm font-medium">{t("docs.getMessage")}</div>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t("copy")}
                            onClick={() => copyToClipboard(
                              `curl ${window.location.protocol}//${window.location.host}/api/emails/{emailId}/{messageId} \\
  -H "X-API-Key: YOUR_API_KEY"`
                            )}
                          >
                            <Copy className="w-4 h-4" aria-hidden="true" />
                          </Button>
                        </div>
                        <pre className="text-xs bg-muted/50 rounded-lg p-4 overflow-x-auto">
                          {`curl ${window.location.protocol}//${window.location.host}/api/emails/{emailId}/{messageId} \\
  -H "X-API-Key: YOUR_API_KEY"`}
                        </pre>
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="text-sm font-medium">{t("docs.createEmailShare")}</div>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t("copy")}
                            onClick={() => copyToClipboard(
                              `curl -X POST ${window.location.protocol}//${window.location.host}/api/emails/{emailId}/share \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"expiresIn": 86400000}'`
                            )}
                          >
                            <Copy className="w-4 h-4" aria-hidden="true" />
                          </Button>
                        </div>
                        <pre className="text-xs bg-muted/50 rounded-lg p-4 overflow-x-auto">
                          {`curl -X POST ${window.location.protocol}//${window.location.host}/api/emails/{emailId}/share \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"expiresIn": 86400000}'`}
                        </pre>
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="text-sm font-medium">{t("docs.getEmailShares")}</div>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t("copy")}
                            onClick={() => copyToClipboard(
                              `curl ${window.location.protocol}//${window.location.host}/api/emails/{emailId}/share \\
  -H "X-API-Key: YOUR_API_KEY"`
                            )}
                          >
                            <Copy className="w-4 h-4" aria-hidden="true" />
                          </Button>
                        </div>
                        <pre className="text-xs bg-muted/50 rounded-lg p-4 overflow-x-auto">
                          {`curl ${window.location.protocol}//${window.location.host}/api/emails/{emailId}/share \\
  -H "X-API-Key: YOUR_API_KEY"`}
                        </pre>
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="text-sm font-medium">{t("docs.deleteEmailShare")}</div>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t("copy")}
                            onClick={() => copyToClipboard(
                              `curl -X DELETE ${window.location.protocol}//${window.location.host}/api/emails/{emailId}/share/{shareId} \\
  -H "X-API-Key: YOUR_API_KEY"`
                            )}
                          >
                            <Copy className="w-4 h-4" aria-hidden="true" />
                          </Button>
                        </div>
                        <pre className="text-xs bg-muted/50 rounded-lg p-4 overflow-x-auto">
                          {`curl -X DELETE ${window.location.protocol}//${window.location.host}/api/emails/{emailId}/share/{shareId} \\
  -H "X-API-Key: YOUR_API_KEY"`}
                        </pre>
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="text-sm font-medium">{t("docs.createMessageShare")}</div>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t("copy")}
                            onClick={() => copyToClipboard(
                              `curl -X POST ${window.location.protocol}//${window.location.host}/api/emails/{emailId}/messages/{messageId}/share \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"expiresIn": 0}'`
                            )}
                          >
                            <Copy className="w-4 h-4" aria-hidden="true" />
                          </Button>
                        </div>
                        <pre className="text-xs bg-muted/50 rounded-lg p-4 overflow-x-auto">
                          {`curl -X POST ${window.location.protocol}//${window.location.host}/api/emails/{emailId}/messages/{messageId}/share \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"expiresIn": 0}'`}
                        </pre>
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="text-sm font-medium">{t("docs.getMessageShares")}</div>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t("copy")}
                            onClick={() => copyToClipboard(
                              `curl ${window.location.protocol}//${window.location.host}/api/emails/{emailId}/messages/{messageId}/share \\
  -H "X-API-Key: YOUR_API_KEY"`
                            )}
                          >
                            <Copy className="w-4 h-4" aria-hidden="true" />
                          </Button>
                        </div>
                        <pre className="text-xs bg-muted/50 rounded-lg p-4 overflow-x-auto">
                          {`curl ${window.location.protocol}//${window.location.host}/api/emails/{emailId}/messages/{messageId}/share \\
  -H "X-API-Key: YOUR_API_KEY"`}
                        </pre>
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="text-sm font-medium">{t("docs.deleteMessageShare")}</div>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t("copy")}
                            onClick={() => copyToClipboard(
                              `curl -X DELETE ${window.location.protocol}//${window.location.host}/api/emails/{emailId}/messages/{messageId}/share/{shareId} \\
  -H "X-API-Key: YOUR_API_KEY"`
                            )}
                          >
                            <Copy className="w-4 h-4" aria-hidden="true" />
                          </Button>
                        </div>
                        <pre className="text-xs bg-muted/50 rounded-lg p-4 overflow-x-auto">
                          {`curl -X DELETE ${window.location.protocol}//${window.location.host}/api/emails/{emailId}/messages/{messageId}/share/{shareId} \\
  -H "X-API-Key: YOUR_API_KEY"`}
                        </pre>
                      </div>

                      <div className="text-xs text-muted-foreground mt-4">
                        <p>{t("docs.notes")}</p>
                        <ul className="list-disc list-inside space-y-1 mt-2">
                          <li>{t("docs.note1")}</li>
                          <li>{t("docs.note2")}</li>
                          <li>{t("docs.note3")}</li>
                          <li>{t("docs.note4")}</li>
                          <li>{t("docs.note5")}</li>
                          <li>{t("docs.note6")}</li>
                          <li>{t("docs.note7")}</li>
                          <li>{t("docs.note8")}</li>
                          <li>{t("docs.note9")}</li>
                          <li>{t("docs.note10")}</li>
                        </ul>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )
      }
    </div>
  )
}
