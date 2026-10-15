"use client"

import { useTranslations } from "next-intl"
import Image from "next/image"
import { Button } from "@/components/ui/button"
import { Crown, Gem, Sword, User2, Loader2, Search, ChevronLeft, ChevronRight, Users, Trash2 } from "lucide-react"
import { Input } from "@/components/ui/input"
import { useState, useEffect, useCallback } from "react"
import { useToast } from "@/components/ui/use-toast"
import { ROLES, Role } from "@/lib/permissions"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { useConfig } from "@/hooks/use-config"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

const roleIcons = {
  [ROLES.EMPEROR]: Crown,
  [ROLES.DUKE]: Gem,
  [ROLES.KNIGHT]: Sword,
  [ROLES.CIVILIAN]: User2,
} as const

type RoleWithoutEmperor = Exclude<Role, typeof ROLES.EMPEROR>

interface UserItem {
  id: string
  name: string | null
  username: string | null
  email: string | null
  image: string | null
  role: string | null
  allowedDomains: string[] | null
}

const PAGE_SIZE = 10

function sameDomainAccess(first: string[] | null, second: string[] | null) {
  if (first === null || second === null) return first === second
  if (first.length !== second.length) return false
  const secondDomains = new Set(second)
  return first.every(domain => secondDomains.has(domain))
}

export function PromotePanel() {
  const t = useTranslations("profile.promote")
  const tCard = useTranslations("profile.card")
  const { config, loading: configLoading, error: configError, fetch: fetchConfig } = useConfig()
  const configuredDomains = config?.emailDomainsArray ?? []
  const [users, setUsers] = useState<UserItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(true)
  const [updatingUserId, setUpdatingUserId] = useState<string | null>(null)
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null)
  const [savingDomainsUserId, setSavingDomainsUserId] = useState<string | null>(null)
  const [domainDrafts, setDomainDrafts] = useState<Record<string, string[] | null>>({})
  const [userToDelete, setUserToDelete] = useState<UserItem | null>(null)
  const { toast } = useToast()

  const roleNames = {
    [ROLES.EMPEROR]: tCard("roles.EMPEROR"),
    [ROLES.DUKE]: tCard("roles.DUKE"),
    [ROLES.KNIGHT]: tCard("roles.KNIGHT"),
    [ROLES.CIVILIAN]: tCard("roles.CIVILIAN"),
  } as const

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const fetchUsers = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({
        page: page.toString(),
        pageSize: PAGE_SIZE.toString(),
      })
      if (search.trim()) {
        params.set("search", search.trim())
      }
      const res = await fetch(`/api/roles/users?${params}`)
      if (!res.ok) throw new Error("Failed to fetch")
      const data = await res.json() as {
        users: UserItem[]
        total: number
        page: number
        pageSize: number
      }
      setUsers(data.users)
      setTotal(data.total)
    } catch {
      toast({
        title: t("updateFailed"),
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }, [page, search, t, toast])

  useEffect(() => {
    fetchUsers()
  }, [fetchUsers])

  useEffect(() => {
    setPage(1)
  }, [search])

  const handleRoleChange = async (userId: string, newRole: RoleWithoutEmperor) => {
    setUpdatingUserId(userId)
    try {
      const res = await fetch("/api/roles/promote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, roleName: newRole }),
      })
      if (!res.ok) {
        const error = await res.json() as { error: string }
        throw new Error(error.error)
      }
      setUsers((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, role: newRole } : u))
      )
      toast({ title: t("updateSuccess") })
    } catch (error) {
      toast({
        title: t("updateFailed"),
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      })
    } finally {
      setUpdatingUserId(null)
    }
  }

  const setDomainAccessDraft = (userId: string, allowedDomains: string[] | null) => {
    setDomainDrafts(prev => ({ ...prev, [userId]: allowedDomains }))
  }

  const handleDomainToggle = (userId: string, allowedDomains: string[] | null, domain: string, checked: boolean) => {
    const selectedDomains = allowedDomains === null
      ? configuredDomains
      : allowedDomains.filter(value => configuredDomains.includes(value))
    const nextDomains = checked
      ? [...new Set([...selectedDomains, domain])]
      : selectedDomains.filter(value => value !== domain)
    const nextAccess = configuredDomains.length > 0 && configuredDomains.every(value => nextDomains.includes(value))
      ? null
      : nextDomains

    setDomainAccessDraft(userId, nextAccess)
  }

  const saveDomainAccess = async (userId: string, allowedDomains: string[] | null) => {
    setSavingDomainsUserId(userId)
    try {
      const res = await fetch("/api/roles/user-domains", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, allowedDomains }),
      })
      if (!res.ok) {
        const error = await res.json() as { error: string }
        throw new Error(error.error)
      }
      const data = await res.json() as { allowedDomains: string[] | null }
      setUsers(prev => prev.map(user => user.id === userId ? { ...user, allowedDomains: data.allowedDomains } : user))
      setDomainDrafts(prev => {
        const next = { ...prev }
        delete next[userId]
        return next
      })
      toast({ title: t("domainUpdateSuccess") })
    } catch (error) {
      toast({
        title: t("domainUpdateFailed"),
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      })
    } finally {
      setSavingDomainsUserId(null)
    }
  }

  const handleDelete = async (user: UserItem) => {
    setDeletingUserId(user.id)
    try {
      const res = await fetch(`/api/users/${user.id}`, {
        method: "DELETE",
      })
      if (!res.ok) {
        const error = await res.json() as { error: string }
        throw new Error(error.error)
      }
      toast({ title: t("deleteSuccess") })
      setUserToDelete(null)
      // 若删除的是当前页最后一条，且不在首页，则退回上一页（useEffect 会重新拉取）
      if (users.length === 1 && page > 1) {
        setPage((p) => p - 1)
      } else {
        await fetchUsers()
      }
    } catch (error) {
      toast({
        title: t("deleteFailed"),
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      })
    } finally {
      setDeletingUserId(null)
    }
  }

  return (
    <div className="fluent-panel p-6">
      <div className="flex items-center gap-2 mb-6">
        <Users className="w-5 h-5 text-primary" />
        <h2 className="text-lg font-semibold">{t("title")}</h2>
        <span className="text-sm text-muted-foreground ml-auto">
          {t("totalUsers", { count: total })}
        </span>
      </div>

      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("searchPlaceholder")}
          className="pl-9"
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
          <span className="ml-2 text-muted-foreground">{t("loading")}</span>
        </div>
      ) : users.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          {t("noUsers")}
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {users.map((user) => {
              const isEmperor = user.role === ROLES.EMPEROR
              const RoleIcon = roleIcons[user.role as Role] || User2
              const isUpdating = updatingUserId === user.id
              const hasDomainDraft = Object.prototype.hasOwnProperty.call(domainDrafts, user.id)
              const allowedDomains = hasDomainDraft ? domainDrafts[user.id] ?? null : user.allowedDomains ?? null
              const selectedDomains = allowedDomains === null
                ? configuredDomains
                : (allowedDomains ?? []).filter(domain => configuredDomains.includes(domain))
              const isSavingDomains = savingDomainsUserId === user.id
              const domainAccessChanged = !sameDomainAccess(allowedDomains, user.allowedDomains ?? null)

              return (
                <div
                  key={user.id}
                  className="rounded-lg border border-border p-3 hover:bg-accent/50 transition-colors"
                >
                  <div className="flex flex-wrap items-center gap-3">
                    {user.image ? (
                      <Image
                        src={user.image}
                        alt=""
                        width={32}
                        height={32}
                        className="w-8 h-8 rounded-full"
                      />
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                        <User2 className="w-4 h-4 text-primary" />
                      </div>
                    )}

                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm truncate">
                        {user.name || user.username || "—"}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {user.email || user.username || "—"}
                      </div>
                    </div>

                    {isEmperor ? (
                      <div className="flex items-center gap-1.5 text-sm text-amber-600 font-medium px-3">
                        <Crown className="w-4 h-4" />
                        {roleNames[ROLES.EMPEROR]}
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <div className="relative">
                          {isUpdating && (
                            <div className="absolute inset-0 flex items-center justify-center bg-background/80 rounded-sm z-10">
                              <Loader2 className="w-4 h-4 animate-spin" />
                            </div>
                          )}
                          <Select
                            value={user.role || ROLES.CIVILIAN}
                            onValueChange={(v) => handleRoleChange(user.id, v as RoleWithoutEmperor)}
                            disabled={isUpdating}
                          >
                            <SelectTrigger className="w-32 h-8 text-sm">
                              <div className="flex items-center gap-1.5">
                                <RoleIcon className="w-3.5 h-3.5" />
                                <SelectValue />
                              </div>
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={ROLES.DUKE}>
                                <div className="flex items-center gap-2">
                                  <Gem className="w-4 h-4" />
                                  {roleNames[ROLES.DUKE]}
                                </div>
                              </SelectItem>
                              <SelectItem value={ROLES.KNIGHT}>
                                <div className="flex items-center gap-2">
                                  <Sword className="w-4 h-4" />
                                  {roleNames[ROLES.KNIGHT]}
                                </div>
                              </SelectItem>
                              <SelectItem value={ROLES.CIVILIAN}>
                                <div className="flex items-center gap-2">
                                  <User2 className="w-4 h-4" />
                                  {roleNames[ROLES.CIVILIAN]}
                                </div>
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          onClick={() => setUserToDelete(user)}
                          title={t("deleteUser")}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    )}
                  </div>

                  {!isEmperor && (
                    <div className="mt-3 border-t border-border pt-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p className="text-sm font-medium">{t("allowedDomains")}</p>
                          <p className="text-xs text-muted-foreground">
                            {allowedDomains === null ? t("allDomainsDescription") : t("selectedDomainsDescription")}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => setDomainAccessDraft(user.id, null)}
                            disabled={isSavingDomains || allowedDomains === null}
                          >
                            {t("allDomains")}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => saveDomainAccess(user.id, allowedDomains ?? null)}
                            disabled={!domainAccessChanged || isSavingDomains || configLoading || !config}
                          >
                            {isSavingDomains ? <Loader2 className="w-4 h-4 animate-spin" /> : t("saveDomains")}
                          </Button>
                        </div>
                      </div>

                      {configuredDomains.length > 0 ? (
                        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
                          {configuredDomains.map((domain, index) => {
                            const checked = selectedDomains.includes(domain)
                            const inputId = `user-${user.id}-domain-${index}`
                            return (
                              <Label key={domain} htmlFor={inputId} className="flex cursor-pointer items-center gap-2 text-sm font-normal">
                                <Checkbox
                                  id={inputId}
                                  checked={checked}
                                  disabled={isSavingDomains}
                                  onChange={(value) => handleDomainToggle(user.id, allowedDomains ?? null, domain, value)}
                                />
                                @{domain}
                              </Label>
                            )
                          })}
                        </div>
                      ) : configError ? (
                        <div role="alert" className="mt-2 flex items-center gap-2 text-sm text-destructive">
                          <span>{t("domainConfigFailed")}</span>
                          <Button type="button" variant="outline" size="sm" onClick={() => void fetchConfig()} disabled={configLoading}>
                            {t("retryDomains")}
                          </Button>
                        </div>
                      ) : (
                        <p className="mt-2 text-sm text-muted-foreground">
                          {configLoading ? t("loading") : t("noConfiguredDomains")}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4 pt-4 border-t">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
              >
                <ChevronLeft className="w-4 h-4 mr-1" />
                {t("prevPage")}
              </Button>
              <span className="text-sm text-muted-foreground">
                {t("pageInfo", { current: page, total: totalPages })}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
              >
                {t("nextPage")}
                <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
          )}
        </>
      )}

      <AlertDialog
        open={!!userToDelete}
        onOpenChange={(open) => {
          if (!open && !deletingUserId) setUserToDelete(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteConfirm", {
                name:
                  userToDelete?.name ||
                  userToDelete?.username ||
                  userToDelete?.email ||
                  "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!deletingUserId}>
              {t("cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={!!deletingUserId}
              onClick={(e) => {
                e.preventDefault()
                if (userToDelete) handleDelete(userToDelete)
              }}
            >
              {deletingUserId ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                t("deleteConfirmButton")
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
