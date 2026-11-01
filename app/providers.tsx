"use client"

import { ServiceWorker } from "@/components/service-worker"
import { SessionProvider } from "next-auth/react"
import type { Session } from "next-auth"
import { MotionPreferences } from "@/components/motion-preferences"
import { usePathname } from "next/navigation"

export function Providers({ children, session }: { children: React.ReactNode; session: Session | null }) {
  const pathname = usePathname()
  const sharedProviders = (
    <>
      <ServiceWorker />
      <MotionPreferences />
      {children}
    </>
  )

  // The login form calls signIn directly and has no useSession consumers. Avoid
  // mounting SessionProvider there; its dev-mode effect replay can fetch the
  // session before the credentials form is submitted.
  if (!session?.user && /^\/[^/]+\/login\/?$/.test(pathname)) {
    return sharedProviders
  }

  return (
    <SessionProvider session={session}>
      {sharedProviders}
    </SessionProvider>
  )
}
