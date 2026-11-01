"use client"

import { useSession } from "next-auth/react"
import { Role } from "@/lib/permissions"
import { useEffect, useState, useSyncExternalStore } from "react"

function createRoleCache() {
  let cachedRole: Role | null = null
  const listeners = new Set<() => void>()

  return {
    getSnapshot: () => cachedRole,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    update: (role: Role) => {
      if (cachedRole === role) return
      cachedRole = role
      listeners.forEach((listener) => listener())
    },
  }
}

export function useUserRole() {
  const { data: session } = useSession()
  const [roleCache] = useState(createRoleCache)
  const role = useSyncExternalStore(
    roleCache.subscribe,
    roleCache.getSnapshot,
    roleCache.getSnapshot
  )

  useEffect(() => {
    if (session?.user?.roles?.[0]?.name) {
      roleCache.update(session.user.roles[0].name as Role)
    }
  }, [session, roleCache])

  return {
    role,
    loading: !session
  }
}
