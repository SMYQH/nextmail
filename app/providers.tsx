"use client"

import { ServiceWorker } from "@/components/service-worker"
import { SessionProvider } from "next-auth/react"
import { MotionPreferences } from "@/components/motion-preferences"

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <ServiceWorker />
      <MotionPreferences />
      {children}
    </SessionProvider>
  )
}
