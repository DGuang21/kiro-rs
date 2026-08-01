import { cn } from '@/lib/utils'
import { railDotClass, type RailTone } from './rail'

export interface StatusSegment {
  /** 段标签，如「可用」「冷却」 */
  label: string
  count: number
  tone: RailTone
  /** 点击后的筛选动作；不给则该段不可点 */
  onClick?: () => void
  /** 该段当前是否为激活的筛选条件 */
  active?: boolean
  hint?: string
}

export function StatusStrip({
  segments,
  className,
  trailing,
}: {
  segments: StatusSegment[]
  className?: string
  /** 右侧附加内容（如调度模式、总数） */
  trailing?: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'console-scope flex flex-wrap items-center justify-between gap-3 py-1',
        className,
      )}
    >
      {/* 现代 Apple / Shadcn 极简分段控制卡片 (Segmented Control Bar) */}
      <div className="inline-flex max-w-full flex-wrap items-center gap-1 rounded-xl border border-border/50 bg-muted/40 p-1 backdrop-blur-sm">
        {segments.map((s) => {
          const clickable = !!s.onClick
          const inner = (
            <>
              {s.tone !== 'none' && (
                <span
                  className={cn(
                    'h-2 w-2 shrink-0 rounded-full transition-transform',
                    railDotClass(s.tone),
                    !s.active && s.count === 0 && 'opacity-40',
                  )}
                />
              )}
              <span className="font-medium">{s.label}</span>
              <span
                className={cn(
                  'console-num font-mono text-[11px] font-bold leading-none px-1.5 py-0.5 rounded-md transition-colors',
                  s.active
                    ? 'bg-primary/10 text-primary'
                    : s.count === 0
                      ? 'text-muted-foreground/40'
                      : 'text-foreground/70 bg-background/50',
                )}
              >
                {s.count}
              </span>
            </>
          )

          if (!clickable) {
            return (
              <span
                key={s.label}
                title={s.hint}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground"
              >
                {inner}
              </span>
            )
          }

          return (
            <button
              key={s.label}
              type="button"
              onClick={s.onClick}
              title={s.hint}
              aria-pressed={s.active}
              className={cn(
                'inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs transition-all duration-200 select-none cursor-pointer',
                s.active
                  ? 'bg-background font-semibold text-foreground shadow-apple-sm border border-border/50'
                  : 'text-muted-foreground hover:bg-background/50 hover:text-foreground',
              )}
            >
              {inner}
            </button>
          )
        })}
      </div>

      {trailing && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {trailing}
        </div>
      )}
    </div>
  )
}
