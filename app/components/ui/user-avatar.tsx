"use client"

import { useState } from "react"
import Image from "next/image"
import { generateAvatarUrl } from "@/lib/avatar"

interface UserAvatarProps {
  src?: string | null
  name: string
  size: number
  className?: string
}

export function UserAvatar({ src, name, size, className }: UserAvatarProps) {
  const [failedSource, setFailedSource] = useState<string | null>(null)
  const source = src && src !== failedSource ? src : generateAvatarUrl(name)

  return (
    <Image
      src={source}
      alt={name}
      width={size}
      height={size}
      unoptimized
      className={className}
      onError={() => { if (src) setFailedSource(src) }}
    />
  )
}
