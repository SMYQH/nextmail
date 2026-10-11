"use client"

import Link from "next/link"
import { BrandIcon } from "@/components/ui/brand-icon"

export function Logo() {
  return (
    <Link 
      href="/"
      className="flex items-center gap-2 rounded-md hover:opacity-80 transition-opacity"
    >
      <BrandIcon />
      <span className="font-semibold tracking-tight text-foreground">
        NextMail
      </span>
    </Link>
  )
}
