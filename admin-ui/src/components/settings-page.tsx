import { useEffect, useState } from 'react'
import { Settings2, FolderTree, Network, Activity, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { GroupsPage } from '@/components/groups-page'
import { ProxyPoolPage } from '@/components/proxy-pool-page'
import { SchedulingPanel } from '@/components/settings/scheduling-panel'
import { ResiliencePanel } from '@/components/settings/resilience-panel'

/**
 * 系统设置页：把原先散落在顶栏下拉和独立 Tab 里的配置项收拢到一处。
 *
 * 四个二级面板：
 * - 调度策略：负载均衡模式（含优先级随机）
 * - 风控重试：账号级风控故障转移 + 冷却时长 + 失败重试次数 + 凭据自愈
 * - 分组管理：复用 GroupsPage
 * - 代理池：复用 ProxyPoolPage
 *
 * 二级 Tab 写进 hash（`#/settings/proxies`），刷新后停在原位；旧链接
 * `#/groups`、`#/proxies` 由 App 负责重定向到这里。
 */
export type SettingsSection = 'scheduling' | 'resilience' | 'groups' | 'proxies'

const SECTIONS: {
  key: SettingsSection
  label: string
  mobileLabel: string
  icon: React.ReactNode
}[] = [
  {
    key: 'scheduling',
    label: '调度策略',
    mobileLabel: '调度',
    icon: <Activity className="h-3.5 w-3.5" />,
  },
  {
    key: 'resilience',
    label: '风控重试',
    mobileLabel: '风控',
    icon: <ShieldCheck className="h-3.5 w-3.5" />,
  },
  {
    key: 'groups',
    label: '分组管理',
    mobileLabel: '分组',
    icon: <FolderTree className="h-3.5 w-3.5" />,
  },
  {
    key: 'proxies',
    label: '代理池',
    mobileLabel: '代理',
    icon: <Network className="h-3.5 w-3.5" />,
  },
]

const DEFAULT_SECTION: SettingsSection = 'scheduling'

function isSettingsSection(value: string): value is SettingsSection {
  return SECTIONS.some((s) => s.key === value)
}

/** 从 hash 第二段读二级 Tab，例如 `#/settings/proxies` → `proxies` */
export function readSectionFromHash(): SettingsSection {
  const raw = window.location.hash.replace(/^#\/?/, '')
  const sub = raw.split('/')[1] ?? ''
  return isSettingsSection(sub) ? sub : DEFAULT_SECTION
}

export function SettingsPage() {
  const [section, setSection] = useState<SettingsSection>(readSectionFromHash)

  useEffect(() => {
    const onHash = () => setSection(readSectionFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const switchSection = (next: SettingsSection) => {
    window.location.hash = `#/settings/${next}`
    setSection(next)
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold leading-tight tracking-tight sm:text-[28px]">
          <Settings2 className="h-6 w-6" />
          系统设置
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          调度策略、风控重试、分组与代理池的集中配置入口
        </p>
      </div>

      <SectionTabs section={section} onSwitch={switchSection} />

      {section === 'scheduling' && <SchedulingPanel />}
      {section === 'resilience' && <ResiliencePanel />}
      {section === 'groups' && <GroupsPage embedded />}
      {section === 'proxies' && <ProxyPoolPage embedded />}
    </div>
  )
}

function SectionTabs({
  onSwitch,
  section,
}: {
  onSwitch: (next: SettingsSection) => void
  section: SettingsSection
}) {
  return (
    <div className="flex items-center gap-1 overflow-x-auto rounded-full border border-border/60 p-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {SECTIONS.map((s) => (
        <Button
          key={s.key}
          size="sm"
          variant={section === s.key ? 'default' : 'ghost'}
          className="h-7 shrink-0 rounded-full px-3 text-xs"
          onClick={() => onSwitch(s.key)}
        >
          {s.icon}
          <span className="hidden min-[420px]:inline">{s.label}</span>
          <span className="min-[420px]:hidden">{s.mobileLabel}</span>
        </Button>
      ))}
    </div>
  )
}
