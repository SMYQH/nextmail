interface FeatureCardProps { 
  icon: React.ReactNode
  title: string
  description: string 
}

export function FeatureCard({ icon, title, description }: FeatureCardProps) {
  return (
    <div className="fluent-hero-card p-5">
      <div className="flex items-center gap-4">
        <div className="shrink-0 text-primary" aria-hidden="true">
          {icon}
        </div>
        <div className="min-w-0 text-left space-y-1">
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
        </div>
      </div>
    </div>
  )
}
