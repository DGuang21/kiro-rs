import { cn } from '@/lib/utils'
import { railDotClass, type RailTone } from './rail'

/**
 * 状态标签条 —— 凭据列表的表头兼筛选器。
 *
 * 两轮设计的经过值得记一下。最初把顶部三张大数字统计卡换成了一条 28px 的细账条，
 * 省下约 140px 首屏。但省过头了：这一页最主要的筛选控件被做成了 12.5px 的说明文字，
 * 看上去像图注而不是可点的东西；而且它待在标题下方，与它筛选的那个列表之间还隔着
 * 两行工具栏 —— 想按状态过滤的人未必会想到去点它。
 *
 * 现在改成贴着列表的标签页：
 * - **紧邻**：它就是列表的表头，中间不再隔任何东西，改哪个数字影响哪片区域一目了然
 * - **显眼**：34px 行高、计数用 15px 半粗等宽，激活项带底边线；标签页这个形状本身
 *   就在说"我是切换视图的"，不需要额外提示
 * - 底边线用该状态的色轨色：选中「冷却」时，下面那些行的左侧橙色轨与上面的橙色底线
 *   是同一个信号，颜色把表头和它筛出来的行系在一起
 *
 * 补了一个「全部」标签。原先靠"再点一次激活项来取消"，那是个藏起来的操作 ——
 * 用户看不出还能退回全集。
 */
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

/** 激活项底边线用色轨色，与被筛出的行左侧色轨对应 */
const ACTIVE_BORDER: Record<RailTone, string> = {
  ok: 'border-emerald-500',
  warn: 'border-amber-500',
  cool: 'border-orange-500',
  dead: 'border-red-500',
  none: 'border-primary',
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
  // 计数为 0 的状态也保留：'冷却 0' 本身是有用的信息（当前没有被风控的号），
  // 而标签忽隐忽现会让这一行的位置不停跳动。
  return (
    <div
      className={cn(
        'console-scope flex flex-wrap items-end gap-x-0.5 gap-y-1 border-b border-border/60',
        className,
      )}
    >
      {segments.map((s) => {
        const clickable = !!s.onClick
        const inner = (
          <>
            {s.tone !== 'none' && (
              <span
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  railDotClass(s.tone),
                  // 非激活且为 0 时弱化圆点，避免一排彩点抢注意力
                  !s.active && s.count === 0 && 'opacity-40',
                )}
              />
            )}
            <span>{s.label}</span>
            <span
              className={cn(
                'console-num text-[15px] font-semibold leading-none',
                s.active
                  ? 'text-foreground'
                  : s.count === 0
                    ? 'text-muted-foreground/50'
                    : 'text-foreground/80',
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
              className="inline-flex h-[34px] items-center gap-1.5 border-b-2 border-transparent px-3 text-[13px] text-muted-foreground"
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
              'inline-flex h-[34px] items-center gap-1.5 border-b-2 px-3 text-[13px] transition-colors',
              '-mb-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40',
              s.active
                ? cn('font-medium text-foreground', ACTIVE_BORDER[s.tone])
                : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground',
            )}
          >
            {inner}
          </button>
        )
      })}
      {trailing && (
        <div className="ml-auto flex items-center gap-2 self-center pb-1 pl-2">
          {trailing}
        </div>
      )}
    </div>
  )
}
