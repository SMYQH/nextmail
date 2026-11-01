import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

interface EmptyStateProps {
  /** Optional leading glyph; the shared mark keeps every empty state identical. */
  icon?: ReactNode
  /** The existing, already localized message. */
  message: ReactNode
  /** Optional supporting line, e.g. the panel description. */
  description?: ReactNode
  className?: string
}

/**
 * The single empty state used by the mailbox panes, the message lists and the
 * profile panels, so an empty area always reads as the same kind of state.
 */
export function EmptyState({ icon, message, description, className }: EmptyStateProps) {
  return (
    <div className={cn("fluent-empty-state", className)}>
      {icon ? <div className="fluent-mark p-4">{icon}</div> : null}
      <p className="max-w-52 leading-relaxed">{message}</p>
      {description ? (
        <p className="max-w-52 text-sm text-muted-foreground leading-relaxed">{description}</p>
      ) : null}
    </div>
  )
}
