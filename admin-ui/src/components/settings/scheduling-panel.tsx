import { toast } from 'sonner'
import { Check } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { useLoadBalancingMode, useSetLoadBalancingMode } from '@/hooks/use-credentials'
import { loadBalancingModeLabel, type LoadBalancingMode } from '@/api/credentials'
import { extractErrorMessage } from '@/lib/utils'

/**
 * 调度策略面板：负载均衡模式选择。
 *
 * 顶栏原来是一个按钮循环切换四种模式，看不出当前处在哪一档、也看不到各档差别。
 * 这里改成四张并列卡片，直接点选目标模式。
 */
const MODES: { mode: LoadBalancingMode; desc: string }[] = [
  {
    mode: 'priority',
    desc: '始终使用优先级最高的可用凭据，仅在其不可用时下移。适合有主力号 + 备用号的场景。',
  },
  {
    mode: 'priority-balanced',
    desc: '在优先级最高的一档内部做均衡分发，该档全部不可用后才下移到下一档。',
  },
  {
    mode: 'priority-random',
    desc: '在优先级最高的一档内部随机挑选，降低固定顺序带来的请求特征。',
  },
  {
    mode: 'balanced',
    desc: '忽略优先级，在所有可用凭据间均衡分发，最大化整体额度利用率。',
  },
]

export function SchedulingPanel() {
  const { data, isLoading } = useLoadBalancingMode()
  const { mutate, isPending } = useSetLoadBalancingMode()
  const current = data?.mode ?? 'priority'
  const busy = isLoading || isPending

  const select = (mode: LoadBalancingMode) => {
    if (mode === current) return
    mutate(mode, {
      onSuccess: () => toast.success(`已切换到${loadBalancingModeLabel(mode)}`),
      onError: (err) => toast.error(`切换失败: ${extractErrorMessage(err)}`),
    })
  }

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold">负载均衡模式</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {isLoading ? '加载中…' : `当前：${loadBalancingModeLabel(current)}`}
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {MODES.map((m) => (
          <ModeCard
            key={m.mode}
            active={m.mode === current}
            desc={m.desc}
            disabled={busy}
            mode={m.mode}
            onSelect={select}
          />
        ))}
      </div>
    </div>
  )
}

function ModeCard({
  active,
  desc,
  disabled,
  mode,
  onSelect,
}: {
  active: boolean
  desc: string
  disabled: boolean
  mode: LoadBalancingMode
  onSelect: (mode: LoadBalancingMode) => void
}) {
  return (
    <Card
      role="radio"
      aria-checked={active}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onClick={() => !disabled && onSelect(mode)}
      onKeyDown={(e) => {
        if (disabled) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(mode)
        }
      }}
      className={`cursor-pointer transition-colors ${
        active ? 'border-primary bg-primary/5' : 'hover:border-border'
      } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
    >
      <CardContent className="p-3.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">{loadBalancingModeLabel(mode)}</span>
          {active && <Check className="h-4 w-4 shrink-0 text-primary" />}
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{desc}</p>
      </CardContent>
    </Card>
  )
}
