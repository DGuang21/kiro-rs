import {
  Gauge,
  Globe,
  ScrollText,
  PackageOpen,
  ShieldCheck,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { useUrlState } from '@/hooks/use-url-state'
import { cn } from '@/lib/utils'
import { DispatchSection } from '@/components/settings/dispatch-section'
import { NetworkSection } from '@/components/settings/network-section'
import { LogSection } from '@/components/settings/log-section'
import { SystemSection } from '@/components/settings/system-section'
import { SecuritySection } from '@/components/settings/security-section'

/**
 * 设置页 —— 把此前散在三处的 7 个配置端点收拢到一处。
 *
 * 改造前它们分别住在：顶栏按钮（负载均衡）、顶栏两个下拉（风控故障转移、自愈）、
 * 顶栏设置菜单（登录密钥）、日志页下拉（日志治理）、代理池弹窗内（全局代理）、
 * 镜像更新弹窗内（更新配置）。同一类东西分在六个地方，找一个配置得先记住它藏在哪。
 *
 * 顶栏**保留**三个快捷开关（负载均衡 / 故障转移 / 自愈），因为它们是运维高频动作，
 * 一次点击就该切换完；但参数（冷却时长、连续上限、保留天数这些）全部移到这里 ——
 * 下拉菜单里塞数字输入框本来就不是它该干的事。
 */
type SectionKey = 'dispatch' | 'network' | 'log' | 'system' | 'security'

const SECTIONS: {
  key: SectionKey
  label: string
  hint: string
  icon: React.ReactNode
}[] = [
  {
    key: 'dispatch',
    label: '调度',
    hint: '凭据怎么选、失败怎么转、禁用怎么恢复',
    icon: <Gauge className="h-4 w-4" />,
  },
  {
    key: 'network',
    label: '网络',
    hint: '出站代理',
    icon: <Globe className="h-4 w-4" />,
  },
  {
    key: 'log',
    label: '日志',
    hint: '链路追踪与保留期',
    icon: <ScrollText className="h-4 w-4" />,
  },
  {
    key: 'system',
    label: '系统',
    hint: '镜像在线更新',
    icon: <PackageOpen className="h-4 w-4" />,
  },
  {
    key: 'security',
    label: '安全',
    hint: '管理面板登录密钥',
    icon: <ShieldCheck className="h-4 w-4" />,
  },
]

export function SettingsPage() {
  const [urlState, patchUrl] = useUrlState('settings', { s: 'dispatch' })
  const active = (SECTIONS.some((x) => x.key === urlState.s)
    ? urlState.s
    : 'dispatch') as SectionKey

  const current = SECTIONS.find((s) => s.key === active)!

  return (
    <div className="console-scope space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">设置</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          改动即时生效并写入 config.json，无需重启。
        </p>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row">
        {/* 分区导航：桌面端竖排侧栏，窄屏横向滚动的胶囊行 */}
        <nav
          className="flex shrink-0 gap-1 overflow-x-auto pb-1 lg:w-48 lg:flex-col lg:overflow-visible lg:pb-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          aria-label="设置分区"
        >
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => patchUrl({ s: s.key })}
              aria-current={active === s.key ? 'page' : undefined}
              className={cn(
                'inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                active === s.key
                  ? 'bg-primary/12 font-medium text-foreground ring-1 ring-primary/25'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )}
            >
              {s.icon}
              <span className="whitespace-nowrap">{s.label}</span>
            </button>
          ))}
        </nav>

        <Card className="min-w-0 flex-1">
          <CardContent className="p-4 sm:p-5">
            <div className="mb-3 border-b border-border/60 pb-3">
              <h3 className="text-[15px] font-semibold tracking-tight">
                {current.label}
              </h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {current.hint}
              </p>
            </div>

            {active === 'dispatch' && <DispatchSection />}
            {active === 'network' && <NetworkSection />}
            {active === 'log' && <LogSection />}
            {active === 'system' && <SystemSection />}
            {active === 'security' && <SecuritySection />}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
