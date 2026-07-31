import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * 吸底批量操作栏。
 *
 * 解决现状里两个具体问题：
 * 1. 批量验活 / 刷新 Token / 恢复异常 藏在「更多」二级菜单里，选完还要再点两层
 * 2. 操作区在页面顶部，选中若干行、滚到列表中段后，操作入口已经滚出视野
 *
 * 所以它常驻底部：选中 > 0 时滑入，操作直接摆在表面，不再折叠。
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
    <div className="pointer-events-none sticky bottom-4 z-40 flex justify-center px-4">
      <div className="console-bulkbar console-scope pointer-events-auto flex max-w-full flex-wrap items-center gap-2 rounded-full border border-border/70 bg-card/95 px-3 py-2 shadow-apple-lg backdrop-blur-xl">
        <span className="pl-1 text-[13px] whitespace-nowrap">
          已选 <span className="console-num font-semibold">{count}</span> {noun}
        </span>
        <span className="mx-0.5 h-5 w-px bg-border/70" />
        {children}
        <span className="mx-0.5 h-5 w-px bg-border/70" />
        <Button
          size="icon"
          variant="ghost"
          onClick={onClear}
          title="取消选择（Esc）"
          className="h-7 w-7"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}
