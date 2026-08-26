import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface PageHeaderProps {
  icon: ReactNode
  title: ReactNode
  level?: 1 | 2
  description?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  className?: string
}

export function PageHeader({
  actions,
  className,
  description,
  icon,
  level = 1,
  meta,
  title,
}: PageHeaderProps) {
  const Heading = level === 2 ? 'h2' : 'h1'

  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-2', className)}>
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span
            className="flex size-4 shrink-0 items-center justify-center [&>svg]:size-4"
            aria-hidden="true"
          >
            {icon}
          </span>
          <Heading className="text-lg font-semibold">{title}</Heading>
          {meta}
        </div>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}
