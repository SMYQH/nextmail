"use client"

import { create } from "zustand"
import { Role, ROLES } from "@/lib/permissions"
import { EMAIL_CONFIG } from "@/config"
import { useEffect } from "react"
import { normalizeEmailDomains } from "@/lib/email-domains"

interface Config {
  defaultRole: Exclude<Role, typeof ROLES.EMPEROR>
  emailDomains: string
  emailDomainsArray: string[]
  adminContact: string
  maxEmails: number
}

interface ConfigStore {
  config: Config | null
  loading: boolean
  error: string | null
  fetch: () => Promise<void>
}

export const useConfigStore = create<ConfigStore>((set, get) => ({
  config: null,
  loading: false,
  error: null,
  fetch: async () => {
    if (get().loading) return
    try {
      set({ loading: true, error: null })
      let res: Response | undefined
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          res = await fetch("/api/config", { cache: "no-store", signal: AbortSignal.timeout(10_000) })
          if (res.ok || res.status < 500) break
          await res.body?.cancel()
        } catch (error) {
          if (attempt === 2) throw error
        }
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt))
      }
      if (!res?.ok) throw new Error("获取配置失败")
      const data = await res.json() as Config
      set({
        config: {
          defaultRole: data.defaultRole || ROLES.CIVILIAN,
          emailDomains: data.emailDomains,
          emailDomainsArray: normalizeEmailDomains(data.emailDomains),
          adminContact: data.adminContact || "",
          maxEmails: Number(data.maxEmails) || EMAIL_CONFIG.MAX_ACTIVE_EMAILS
        },
        loading: false
      })
    } catch (error) {
      set({ 
        error: error instanceof Error ? error.message : "获取配置失败",
        loading: false 
      })
    }
  }
}))

export function useConfig() {
  const config = useConfigStore(state => state.config)
  const loading = useConfigStore(state => state.loading)
  const error = useConfigStore(state => state.error)
  const fetchConfig = useConfigStore(state => state.fetch)

  useEffect(() => {
    // Each mount gets one bounded attempt, including after a previous failure.
    // Read the store here so loading/error updates cannot start a retry loop.
    if (!useConfigStore.getState().config) {
      void fetchConfig()
    }
  }, [fetchConfig])

  return { config, loading, error, fetch: fetchConfig }
}
