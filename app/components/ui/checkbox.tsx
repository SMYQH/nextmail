import React from "react"
import { Check } from "lucide-react"
import { cn } from "@/lib/utils"

interface CheckboxProps {
  id?: string
  checked?: boolean
  onChange?: (checked: boolean) => void
  className?: string
  disabled?: boolean
}

export const Checkbox: React.FC<CheckboxProps> = ({
  id,
  checked = false,
  onChange,
  className,
  disabled = false
}) => {
  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center w-5 h-5 rounded-xs border border-input focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring",
        checked 
          ? "bg-primary border-primary text-primary-foreground" 
          : "bg-background border-input hover:border-primary/50",
        disabled && "opacity-50 cursor-not-allowed",
        className
      )}
    >
      <input
        type="checkbox"
        id={id}
        checked={checked}
        onChange={(event) => onChange?.(event.target.checked)}
        className="absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        disabled={disabled}
      />
      {checked && (
        <Check 
          aria-hidden="true"
          className="pointer-events-none w-3 h-3 text-current"
        />
      )}
    </span>
  )
}
