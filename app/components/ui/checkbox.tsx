import React from "react"
import { Check } from "lucide-react"
import { cn } from "@/lib/utils"

interface CheckboxProps {
  id?: string
  "aria-label"?: string
  checked?: boolean
  onChange?: (checked: boolean) => void
  className?: string
  disabled?: boolean
  compact?: boolean
}

export const Checkbox: React.FC<CheckboxProps> = ({
  id,
  "aria-label": ariaLabel,
  checked = false,
  onChange,
  className,
  disabled = false,
  compact = false,
}) => {
  return (
    <span
      className={cn(
        "relative inline-grid shrink-0 place-items-center",
        compact ? "size-8" : "size-5",
        className,
      )}
    >
      <input
        type="checkbox"
        id={id}
        aria-label={ariaLabel}
        checked={checked}
        onChange={(event) => onChange?.(event.target.checked)}
        className="peer absolute inset-0 z-10 m-0 size-full cursor-pointer touch-manipulation opacity-0 disabled:cursor-not-allowed"
        disabled={disabled}
      />
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none grid place-items-center border peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring peer-disabled:opacity-50",
          compact ? "size-4 rounded-[3px]" : "size-5 rounded-xs",
          checked
            ? "border-primary bg-primary text-primary-foreground forced-colors:border-[Highlight] forced-colors:bg-[Highlight] forced-colors:text-[HighlightText] forced-colors:[forced-color-adjust:none]"
            : "bg-background peer-hover:border-primary forced-colors:border-[ButtonText]",
          !checked && (compact ? "border-muted-foreground/75" : "border-input"),
        )}
      >
        {checked && <Check className="size-3" />}
      </span>
    </span>
  )
}
