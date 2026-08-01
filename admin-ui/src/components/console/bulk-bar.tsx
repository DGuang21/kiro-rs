import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * 吸底批量操作栏。
 */
export function BulkBar({
  count,
  onClear,
  children,
  noun = '项',
}: {
  count: number
  onClear: () => void
  /** 批量动作按钮 */
  children: React.ReactNode
  /** 计数单位，如「个凭据」 */
  noun?: string
}) {
  if (count === 0) return null

  return (
    <div className="pointer-events-none sticky bottom-5 z-40 flex justify-center px-4">
      <div className="console-bulkbar console-scope pointer-events-auto flex max-w-full flex-wrap items-center gap-2.5 sm:gap-3 rounded-full border border-border/80 bg-card/95 px-4 py-2.5 shadow-apple-xl backdrop-blur-2xl">
        <span className="pl-1 text-xs font-medium whitespace-nowrap text-foreground/90">
          已选 <span className="console-num font-bold text-primary">{count}</span> {noun}
        </span>
        <span className="mx-1 h-4 w-px bg-border/70 shrink-0" />
        <div className="flex flex-wrap items-center gap-2 sm:gap-2.5">
          {children}
        </div>
        <span className="mx-1 h-4 w-px bg-border/70 shrink-0" />
        <Button
          size="icon"
          variant="ghost"
          onClick={onClear}
          title="取消选择（Esc）"
          className="h-8 w-8 rounded-full hover:bg-accent shrink-0 text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
