import { lazy, Suspense } from 'react'
import {
  Cpu,
  FolderTree,
  Gauge,
  Globe,
  KeyRound,
  LockKeyhole,
  PackageOpen,
  PackagePlus,
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  Tags,
} from 'lucide-react'
import { PageHeader } from '@/components/console/page-header'
import { Card, CardContent } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useUrlState } from '@/hooks/use-url-state'
import { cn } from '@/lib/utils'
import { NetworkSection } from '@/components/settings/network-section'
import { LogSection } from '@/components/settings/log-section'
import { SystemSection } from '@/components/settings/system-section'
import { SecuritySection } from '@/components/settings/security-section'
import { MetadataSection } from '@/components/settings/metadata-section'
import { ModelsSection } from '@/components/settings/models-section'
import { SchedulingPanel } from '@/components/settings/scheduling-panel'
import { ResiliencePanel } from '@/components/settings/resilience-panel'

const GroupsPage = lazy(() =>
  import('@/components/groups-page').then((m) => ({ default: m.GroupsPage })),
)
const ClientKeysPage = lazy(() =>
  import('@/components/client-keys-page').then((m) => ({ default: m.ClientKeysPage })),
)
const ProxyPoolPage = lazy(() =>
  import('@/components/proxy-pool-page').then((m) => ({ default: m.ProxyPoolPage })),
)
const UpstreamPage = lazy(() =>
  import('@/components/upstream-page').then((m) => ({ default: m.UpstreamPage })),
)

type SectionKey =
  | 'dispatch'
  | 'resilience'
  | 'groups'
  | 'keys'
  | 'metadata'
  | 'network'
  | 'upstreams'
  | 'models'
  | 'log'
  | 'system'
  | 'security'

type SectionCategory = 'traffic' | 'access' | 'integration' | 'operations'

interface SettingsSection {
  key: SectionKey
  label: string
  icon: React.ReactNode
  category: SectionCategory
}

const CATEGORIES: { key: SectionCategory; label: string }[] = [
  { key: 'traffic', label: '流量与稳定性' },
  { key: 'access', label: '访问与凭据' },
  { key: 'integration', label: '连接与能力' },
  { key: 'operations', label: '运维与安全' },
]

const SECTIONS: SettingsSection[] = [
  {
    key: 'dispatch',
    label: '调度策略',
    icon: <Gauge className="h-4 w-4" />,
    category: 'traffic',
  },
  {
    key: 'resilience',
    label: '容错与自愈',
    icon: <ShieldCheck className="h-4 w-4" />,
    category: 'traffic',
  },
  {
    key: 'groups',
    label: '分组管理',
    icon: <FolderTree className="h-4 w-4" />,
    category: 'access',
  },
  {
    key: 'keys',
    label: '客户端 Key',
    icon: <KeyRound className="h-4 w-4" />,
    category: 'access',
  },
  {
    key: 'metadata',
    label: '凭据字段',
    icon: <Tags className="h-4 w-4" />,
    category: 'access',
  },
  {
    key: 'network',
    label: '网络与代理',
    icon: <Globe className="h-4 w-4" />,
    category: 'integration',
  },
  {
    key: 'upstreams',
    label: '补货上游',
    icon: <PackagePlus className="h-4 w-4" />,
    category: 'integration',
  },
  {
    key: 'models',
    label: '模型管理',
    icon: <Cpu className="h-4 w-4" />,
    category: 'integration',
  },
  {
    key: 'log',
    label: '日志治理',
    icon: <ScrollText className="h-4 w-4" />,
    category: 'operations',
  },
  {
    key: 'system',
    label: '系统更新',
    icon: <PackageOpen className="h-4 w-4" />,
    category: 'operations',
  },
  {
    key: 'security',
    label: '安全',
    icon: <LockKeyhole className="h-4 w-4" />,
    category: 'operations',
  },
]

const SECTION_KEYS = new Set<SectionKey>(SECTIONS.map((section) => section.key))
const FRAMED_SECTIONS = new Set<SectionKey>([
  'metadata',
  'models',
  'log',
  'system',
  'security',
])

function normalizeSection(value: string): SectionKey {
  if (value === 'advanced') return 'resilience'
  return SECTION_KEYS.has(value as SectionKey) ? (value as SectionKey) : 'dispatch'
}

export function SettingsPage() {
  const [urlState, patchUrl] = useUrlState('settings', { s: 'dispatch' })
  const active = normalizeSection(urlState.s)

  const content = (
    <Suspense
      fallback={
        <div className="py-10 text-center text-sm text-muted-foreground">加载中…</div>
      }
    >
      <SettingsContent active={active} />
    </Suspense>
  )

  return (
    <div className="console-scope space-y-4">
      <PageHeader
        icon={<SlidersHorizontal className="h-4 w-4" />}
        title="设置"
        description="集中管理调度、访问控制、网络连接和系统运维。"
      />

      <MobileSectionSelect active={active} onChange={(s) => patchUrl({ s })} />

      <div className="flex min-w-0 gap-6">
        <SettingsSidebar active={active} onChange={(s) => patchUrl({ s })} />
        <div className="min-w-0 flex-1">
          {FRAMED_SECTIONS.has(active) ? (
            <Card>
              <CardContent className="p-4 sm:p-5">{content}</CardContent>
            </Card>
          ) : (
            content
          )}
        </div>
      </div>
    </div>
  )
}

function SettingsSidebar({
  active,
  onChange,
}: {
  active: SectionKey
  onChange: (s: SectionKey) => void
}) {
  return (
    <nav className="hidden w-48 shrink-0 lg:block" aria-label="设置分区">
      <div className="sticky top-20 space-y-4">
        {CATEGORIES.map((category) => (
          <div key={category.key}>
            <div className="mb-1 px-3 text-[11px] font-medium text-muted-foreground">
              {category.label}
            </div>
            <div className="space-y-0.5">
              {SECTIONS.filter((section) => section.category === category.key).map(
                (section) => (
                  <SectionButton
                    key={section.key}
                    section={section}
                    active={active === section.key}
                    onClick={() => onChange(section.key)}
                  />
                ),
              )}
            </div>
          </div>
        ))}
      </div>
    </nav>
  )
}

function SectionButton({
  active,
  onClick,
  section,
}: {
  active: boolean
  onClick: () => void
  section: SettingsSection
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[13px] transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        active
          ? 'bg-primary/12 font-medium text-foreground ring-1 ring-primary/25'
          : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
      )}
    >
      {section.icon}
      <span>{section.label}</span>
    </button>
  )
}

function MobileSectionSelect({
  active,
  onChange,
}: {
  active: SectionKey
  onChange: (s: SectionKey) => void
}) {
  return (
    <div className="lg:hidden">
      <Select value={active} onValueChange={(value) => onChange(value as SectionKey)}>
        <SelectTrigger aria-label="设置分区">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CATEGORIES.map((category) => (
            <div key={category.key}>
              <SelectLabel>{category.label}</SelectLabel>
              {SECTIONS.filter((section) => section.category === category.key).map(
                (section) => (
                  <SelectItem key={section.key} value={section.key}>
                    <span className="flex items-center gap-2">
                      {section.icon}
                      {section.label}
                    </span>
                  </SelectItem>
                ),
              )}
            </div>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function SettingsContent({ active }: { active: SectionKey }) {
  if (active === 'dispatch') return <SchedulingPanel />
  if (active === 'resilience') return <ResiliencePanel />
  if (active === 'groups') return <GroupsPage embedded />
  if (active === 'keys') return <ClientKeysPage embedded />
  if (active === 'metadata') return <MetadataSection />
  if (active === 'network') {
    return (
      <div className="space-y-6">
        <Card>
          <CardContent className="p-4 sm:p-5">
            <NetworkSection />
          </CardContent>
        </Card>
        <ProxyPoolPage embedded />
      </div>
    )
  }
  if (active === 'upstreams') return <UpstreamPage embedded />
  if (active === 'models') return <ModelsSection />
  if (active === 'log') return <LogSection />
  if (active === 'system') return <SystemSection />
  return <SecuritySection />
}
