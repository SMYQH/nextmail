import Image from "next/image"
import { cn } from "@/lib/utils"

interface BrandIconProps {
  size?: number
  className?: string
}

export function BrandIcon({ size = 32, className }: BrandIconProps) {
  return (
    <Image
      src="/icons/nextmail.svg"
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      unoptimized
      className={cn("shrink-0 select-none", className)}
    />
  )
}
