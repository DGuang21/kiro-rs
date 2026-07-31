import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Columns3, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { railClass, type RailTone } from './rail'

/**
 * 运维密集表格 —— 凭据 / 日志共用。
 *
 * 与「卡片」形态的分工：卡片是看的，表格是做的。所以这里的每个取舍都偏向
 * 「一屏能扫多少行」和「手不离键盘能不能走完」：
 *
 * - 行高 34px、字号 12.5px（`.console-table`，见 index.css）
 * - sticky 表头，长列表滚动时列名不丢
 * - 左侧 3px 状态色轨代替整行染色：既标状态，又不牺牲文字对比度
 * - 行内操作 hover 才显形（`.console-row-actions`），静默时不干扰扫读
 * - j/k 移动游标、Enter 打开详情、x 切换选中、Esc 清空
 * - 可选列进列控制菜单并记住选择，避免 12 列硬挤出横向滚动
 */
export interface ConsoleColumn<T> {
  id: string
  header: string
  cell: (row: T) => ReactNode
  /** 默认隐藏，需要时从列控制菜单里打开 */
  optional?: boolean
  /** 数值列右对齐，配合 .console-num 做纵向对齐 */
  align?: 'right'
  /** 表头 title 提示 */
  hint?: string
}

export interface ConsoleTableProps<T> {
  rows: T[]
  columns: ConsoleColumn<T>[]
  rowKey: (row: T) => number | string
  /** 行状态 → 左侧色轨；不给则无轨 */
  tone?: (row: T) => RailTone
  /** 开启行选中（复选框列 + x 键） */
  selectable?: boolean
  selected?: Set<number | string>
  onSelectedChange?: (next: Set<number | string>) => void
  /** 点击行 / 按 Enter 触发，通常用来开详情抽屉 */
  onRowActivate?: (row: T) => void
  /** 行右侧的处置动作，hover / 游标行才显形 */
  rowActions?: (row: T) => ReactNode
  /** 列可见性持久化 key；不给则不显示列控制菜单 */
  columnsStorageKey?: string
  loading?: boolean
  empty?: ReactNode
  /** 表格上方右侧的额外控件（与列控制菜单同一行） */
  toolbar?: ReactNode
}

/** 列可见性：默认隐藏 optional 列，选择记到 localStorage */
function useColumnVisibility<T>(
  columns: ConsoleColumn<T>[],
  storageKey?: string,
) {
  const defaults = useMemo(
    () => columns.filter((c) => !c.optional).map((c) => c.id),
    [columns],
  )

  const [visible, setVisible] = useState<string[]>(() => {
    if (!storageKey) return defaults
    try {
      const raw = localStorage.getItem(storageKey)
      if (!raw) return defaults
      const parsed = JSON.parse(raw) as string[]
      // 与当前列定义求交集：列改名 / 删除后不会残留脏 id
      const known = new Set(columns.map((c) => c.id))
      const kept = parsed.filter((id) => known.has(id))
      return kept.length > 0 ? kept : defaults
    } catch {
      return defaults
    }
  })

  const toggle = useCallback(
    (id: string) => {
      setVisible((prev) => {
        const next = prev.includes(id)
          ? prev.filter((x) => x !== id)
          : [...prev, id]
        // 至少留一列，否则表格退化成空壳
        if (next.length === 0) return prev
        if (storageKey) {
          try {
            localStorage.setItem(storageKey, JSON.stringify(next))
          } catch {
            /* 隐私模式下 localStorage 可能不可写，忽略 */
          }
        }
        return next
      })
    },
    [storageKey],
  )

  // 按列定义原顺序输出，不受用户勾选顺序影响
  const ordered = useMemo(
    () => columns.filter((c) => visible.includes(c.id)),
    [columns, visible],
  )

  return { ordered, visible, toggle }
}

/**
 * 键盘导航：j/k 移动游标、Enter 激活、x 切换选中、Esc 清空选中。
 *
 * 只在表格容器获得焦点（或焦点在表格内）时生效，且输入框内不劫持按键 ——
 * 否则用户在搜索框里打 "j" 会意外跳行。
 */
function useRowKeyboard<T>(opts: {
  rows: T[]
  rowKey: (row: T) => number | string
  cursor: number
  setCursor: (n: number) => void
  onRowActivate?: (row: T) => void
  selectable?: boolean
  selected?: Set<number | string>
  onSelectedChange?: (next: Set<number | string>) => void
}) {
  const {
    rows,
    rowKey,
    cursor,
    setCursor,
    onRowActivate,
    selectable,
    selected,
    onSelectedChange,
  } = opts

  return useCallback(
    (e: React.KeyboardEvent) => {
      const target = e.target as HTMLElement
      // 输入类控件内不劫持按键
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return
      }
      if (rows.length === 0) return

      const move = (delta: number) => {
        e.preventDefault()
        const next = Math.min(Math.max(cursor + delta, 0), rows.length - 1)
        setCursor(next)
      }

      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          move(1)
          break
        case 'k':
        case 'ArrowUp':
          move(-1)
          break
        case 'Enter':
          if (cursor >= 0 && rows[cursor] && onRowActivate) {
            e.preventDefault()
            onRowActivate(rows[cursor])
          }
          break
        case 'x':
          if (selectable && cursor >= 0 && rows[cursor] && onSelectedChange) {
            e.preventDefault()
            const key = rowKey(rows[cursor])
            const next = new Set(selected ?? [])
            if (next.has(key)) next.delete(key)
            else next.add(key)
            onSelectedChange(next)
          }
          break
        case 'Escape':
          if (selectable && onSelectedChange && (selected?.size ?? 0) > 0) {
            e.preventDefault()
            onSelectedChange(new Set())
          }
          break
      }
    },
    [
      rows,
      rowKey,
      cursor,
      setCursor,
      onRowActivate,
      selectable,
      selected,
      onSelectedChange,
    ],
  )
}

export function ConsoleTable<T>({
  rows,
  columns,
  rowKey,
  tone,
  selectable = false,
  selected,
  onSelectedChange,
  onRowActivate,
  rowActions,
  columnsStorageKey,
  loading = false,
  empty,
  toolbar,
}: ConsoleTableProps<T>) {
  const { ordered, visible, toggle } = useColumnVisibility(
    columns,
    columnsStorageKey,
  )
  const [cursor, setCursor] = useState(-1)
  const bodyRef = useRef<HTMLTableSectionElement | null>(null)

  // 行数变化后把游标夹回合法范围，而不是复位。
  //
  // 依赖 rows.length 而非 rows：rows 通常是 `data?.records ?? []`，每次渲染都是新的
  // 数组标识，用它做依赖会让游标被反复清零——30 秒自动刷新一到，j/k 走到哪就丢在哪。
  // 夹取还顺带处理了列表变短（筛选收紧、记录被删）时游标越界的情况。
  useEffect(() => {
    setCursor((prev) => (prev < 0 ? prev : Math.min(prev, rows.length - 1)))
  }, [rows.length])

  // 游标移动时把行滚进视野
  useEffect(() => {
    if (cursor < 0 || !bodyRef.current) return
    const tr = bodyRef.current.children[cursor] as HTMLElement | undefined
    tr?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const onKeyDown = useRowKeyboard({
    rows,
    rowKey,
    cursor,
    setCursor,
    onRowActivate,
    selectable,
    selected,
    onSelectedChange,
  })

  const allSelected =
    rows.length > 0 && rows.every((r) => selected?.has(rowKey(r)))

  const toggleAll = () => {
    if (!onSelectedChange) return
    const next = new Set(selected ?? [])
    if (allSelected) rows.forEach((r) => next.delete(rowKey(r)))
    else rows.forEach((r) => next.add(rowKey(r)))
    onSelectedChange(next)
  }

  const toggleOne = (key: number | string) => {
    if (!onSelectedChange) return
    const next = new Set(selected ?? [])
    if (next.has(key)) next.delete(key)
    else next.add(key)
    onSelectedChange(next)
  }

  const hasHiddenOption = columns.some((c) => c.optional)

  return (
    <div className="console-scope space-y-2">
      {(toolbar || (columnsStorageKey && hasHiddenOption)) && (
        <div className="flex items-center justify-end gap-2">
          {toolbar}
          {columnsStorageKey && hasHiddenOption && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" title="选择显示的列">
                  <Columns3 className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">列</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuLabel>显示的列</DropdownMenuLabel>
                {columns.map((c) => (
                  <DropdownMenuItem
                    key={c.id}
                    onSelect={(e) => {
                      e.preventDefault()
                      toggle(c.id)
                    }}
                    className="gap-2"
                  >
                    <span className="flex h-4 w-4 items-center justify-center">
                      {visible.includes(c.id) && <Check className="h-3.5 w-3.5" />}
                    </span>
                    <span>{c.header}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}

      <div
        className="overflow-x-auto rounded-xl border border-border/60 bg-card/80 backdrop-blur-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        tabIndex={0}
        onKeyDown={onKeyDown}
        role="group"
        aria-label="数据表格，j / k 移动，Enter 查看详情"
      >
        <table className="console-table">
          <thead>
            <tr>
              {selectable && (
                <th className="w-9 pl-3">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={toggleAll}
                    aria-label="全选当前页"
                  />
                </th>
              )}
              {ordered.map((c) => (
                <th
                  key={c.id}
                  title={c.hint}
                  className={c.align === 'right' ? 'text-right' : undefined}
                >
                  {c.header}
                </th>
              ))}
              {rowActions && <th className="w-px" />}
            </tr>
          </thead>
          <tbody ref={bodyRef}>
            {rows.map((row, i) => {
              const key = rowKey(row)
              const isSelected = selected?.has(key) ?? false
              return (
                <tr
                  key={key}
                  data-selected={isSelected || undefined}
                  data-cursor={cursor === i || undefined}
                  className={cn(onRowActivate && 'cursor-pointer')}
                  onClick={() => {
                    setCursor(i)
                    onRowActivate?.(row)
                  }}
                >
                  {selectable && (
                    <td
                      className={cn('pl-3', tone && railClass(tone(row)))}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => toggleOne(key)}
                        aria-label="选中此行"
                      />
                    </td>
                  )}
                  {ordered.map((c, ci) => (
                    <td
                      key={c.id}
                      className={cn(
                        c.align === 'right' && 'text-right',
                        // 无复选框列时，色轨落在第一个数据列上
                        !selectable && ci === 0 && tone && railClass(tone(row)),
                      )}
                    >
                      {c.cell(row)}
                    </td>
                  ))}
                  {rowActions && (
                    <td
                      className="pr-3 text-right"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="console-row-actions flex items-center justify-end gap-1">
                        {rowActions(row)}
                      </div>
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>

        {loading && rows.length === 0 && (
          <div className="p-6 text-center text-[13px] text-muted-foreground">
            加载中…
          </div>
        )}
        {!loading && rows.length === 0 && (
          <div className="p-8 text-center text-[13px] text-muted-foreground">
            {empty ?? '没有匹配的记录'}
          </div>
        )}
      </div>
    </div>
  )
}
