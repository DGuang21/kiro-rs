import { useState } from 'react'
import {
  Activity,
  RefreshCw,
  UploadCloud,
  MoreHorizontal,
  ShieldAlert,
  ShieldCheck,
  Boxes,
  HeartPulse,
  HeartCrack,
} from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu'
import {
  useLoadBalancingMode, useSetLoadBalancingMode,
  useAccountThrottleConfig, useSetAccountThrottleConfig,
  useAccountRpmLimitConfig, useSetAccountRpmLimitConfig,
  useSelfHealConfig, useSetSelfHealConfig,
  useRetryConfig, useSetRetryConfig,
} from '@/hooks/use-credentials'
import { useUpdateCheck } from '@/hooks/use-update-check'
import {
  updateAdminKey, nextLoadBalancingMode, loadBalancingModeLabel,
  type SelfHealConfigPatch, type LoadBalancingMode,
} from '@/api/credentials'
import { extractErrorMessage, generateApiKey } from '@/lib/utils'
import { ImageUpdateDialog } from '@/components/image-update-dialog'
import { AvailableModelsDialog } from '@/components/available-models-dialog'

/**
 * 顶栏工具区：三个调度开关 + 三个动作按钮。
 *
 * 这里此前塞了完整的配置面板 —— 冷却时长的 5 个预设按钮、自定义分钟输入、自愈连续
 * 上限输入、登录密钥表单，还各写了 compact / full 两套。下拉菜单里放数字输入框本来
 * 就不是它该干的事：菜单是"选一个动作"的容器，不是表单容器。
 *
 * 现在的分工：**顶栏只放一次点击就能完成的开关**（这三个是运维高频动作，不该退化成
 * "进设置页找"），所有参数调整归「设置」Tab。compact 与 full 因此收敛成同一份
 * 开关定义，窄屏只是把它们折进一个菜单。
 */
interface TopbarToolsProps {
  compact?: boolean
}

// 顶栏“刷新数据”只刷新数据查询；配置查询有各自的保存/轮询语义。
const NON_DATA_QUERY_ROOTS = new Set([
  'loadBalancingMode',
  'accountThrottleConfig',
  'accountRpmLimitConfig',
  'selfHealConfig',
  'logGovernanceConfig',
  'global-proxy',
  'custom-models',
  'update-config',
  'system-update-check',
])

/** 一个开关的完整描述，compact / full 两种排布共用 */
interface ToggleSpec {
  key: string
  /** 当前是否开启 */
  on: boolean
  busy: boolean
  /** full 模式的按钮文案 */
  label: string
  /** compact 模式的菜单项文案（说明这次点击会做什么） */
  menuLabel: string
  title: string
  icon: React.ReactNode
  onToggle: () => void
}

export function TopbarTools({ compact = false }: TopbarToolsProps) {
  const queryClient = useQueryClient()
  const { data: loadBalancingData, isLoading: isLoadingMode } = useLoadBalancingMode()
  const { mutate: setLoadBalancingMode, isPending: isSettingMode } = useSetLoadBalancingMode()
  const { data: throttleConfig, isLoading: isLoadingThrottle } = useAccountThrottleConfig()
  const { mutate: setThrottleConfig, isPending: isSettingThrottle } = useSetAccountThrottleConfig()
  const { data: retryConfig, isLoading: isLoadingRetry } = useRetryConfig()
  const { mutate: setRetryConfig, isPending: isSettingRetry } = useSetRetryConfig()
  const { data: updateCheck } = useUpdateCheck()

  const [imageUpdateOpen, setImageUpdateOpen] = useState(false)
  const [modelsOpen, setModelsOpen] = useState(false)

  const handleRefresh = () => {
    // 刷新所有数据查询；配置查询不属于“刷新数据”，也不会因此触发上游检查。
    queryClient.invalidateQueries({
      predicate: ({ queryKey }) => {
        const root = queryKey[0]
        return typeof root === 'string' && !NON_DATA_QUERY_ROOTS.has(root)
      },
    })
    toast.success('已刷新')
  }

  const handleToggleLoadBalancing = () => {
    const cur = loadBalancingData?.mode || 'priority'
    const next = nextLoadBalancingMode(cur)
    setLoadBalancingMode(next, {
      onSuccess: () => toast.success(`已切换到${loadBalancingModeLabel(next)}`),
      onError: (err) => toast.error(`切换失败: ${extractErrorMessage(err)}`),
    })
  }

  const balanced = lbData?.mode === 'balanced'
  const failover = throttle?.failover ?? true
  const healing = selfHeal?.enabled ?? true
  const cooldownMin = Math.round((throttle?.cooldownSecs ?? 1800) / 60)

  const openKeyDialog = () => {
    setNewKey('')
    setShowPlain(false)
    setKeyDialogOpen(true)
  }

  const handleUpdateKey = async (e: React.FormEvent) => {
    e.preventDefault()
    const key = newKey.trim()
    if (!key) {
      toast.error('新登录API密钥不能为空')
      return
    }
    setUpdating(true)
    try {
      await updateAdminKey({ newKey: key })
      storage.setApiKey(key)
      toast.success('登录API密钥已更新，已自动切换到新 Key')
      setKeyDialogOpen(false)
      setNewKey('')
    } catch (err) {
      toast.error(`更新失败: ${extractErrorMessage(err)}`)
    } finally {
      setUpdating(false)
    }
  }

  const controls = {
    handleRefresh,
    handleToggleFailover,
    handleToggleLoadBalancing,
    isLoadingMode,
    isLoadingThrottle,
    isSettingMode,
    isSettingThrottle,
    loadBalancingMode: loadBalancingData?.mode,
    openImageUpdate: () => setImageUpdateOpen(true),
    openModels: () => setModelsDialogOpen(true),
    openKeyDialog,
    throttleConfig,
    updateCheck,
    updateCooldown: (secs: number) =>
      setThrottleConfig({ cooldownSecs: secs }, {
        onSuccess: () =>
          toast.success(`冷却时长已设为 ${Math.round(secs / 60)} 分钟`),
        onError: (err) => toast.error(`保存失败: ${extractErrorMessage(err)}`),
      }),
    retryConfig,
    isLoadingRetry,
    isSettingRetry,
    updateRetry: (patch: { perCredential: number; total: number }) =>
      setRetryConfig(patch, {
        onSuccess: () =>
          toast.success(`重试次数已更新（每凭据 ${patch.perCredential} · 上限 ${patch.total}）`),
        onError: (err) => toast.error(`保存失败: ${extractErrorMessage(err)}`),
      }),
  }

  return (
    <>
      {compact ? (
        <CompactTools
          toggles={toggles}
          hasUpdate={!!updateCheck?.hasUpdate}
          onRefresh={handleRefresh}
          onOpenModels={() => setModelsOpen(true)}
          onOpenImageUpdate={() => setImageUpdateOpen(true)}
        />
      ) : (
        <FullTools
          toggles={toggles}
          updateCheck={updateCheck}
          onRefresh={handleRefresh}
          onOpenModels={() => setModelsOpen(true)}
          onOpenImageUpdate={() => setImageUpdateOpen(true)}
        />
      )}
      <ImageUpdateDialog open={imageUpdateOpen} onOpenChange={setImageUpdateOpen} />
      <AvailableModelsDialog open={modelsOpen} onOpenChange={setModelsOpen} />
    </>
  )
}

interface ToolControls {
  handleRefresh: () => void
  handleToggleFailover: () => void
  handleToggleLoadBalancing: () => void
  isLoadingMode: boolean
  isLoadingThrottle: boolean
  isSettingMode: boolean
  isSettingThrottle: boolean
  loadBalancingMode?: LoadBalancingMode
  openImageUpdate: () => void
  openKeyDialog: () => void
  openModels: () => void
  throttleConfig?: { failover: boolean; cooldownSecs: number }
  updateCheck?: { hasUpdate: boolean; latestVersion: string; currentVersion: string }
  updateCooldown: (secs: number) => void
  retryConfig?: { perCredential: number; total: number }
  isLoadingRetry: boolean
  isSettingRetry: boolean
  updateRetry: (patch: { perCredential: number; total: number }) => void
}

function FullTools({
  toggles,
  updateCheck,
  onRefresh,
  onOpenModels,
  onOpenImageUpdate,
}: ToolsProps & {
  updateCheck?: { hasUpdate: boolean; latestVersion: string; currentVersion: string }
}) {
  return (
    <>
      <LoadBalancingButton controls={controls} />
      <ThrottleConfigButton
        config={controls.throttleConfig}
        loading={controls.isLoadingThrottle}
        saving={controls.isSettingThrottle}
        onToggleFailover={controls.handleToggleFailover}
        onChangeCooldown={controls.updateCooldown}
        retryConfig={controls.retryConfig}
        retryLoading={controls.isLoadingRetry}
        retrySaving={controls.isSettingRetry}
        onSaveRetry={controls.updateRetry}
      />
      <SelfHealConfigButton />
      <AccountRpmLimitButton />
      <ModelsButton onOpen={controls.openModels} />
      <RefreshButton onRefresh={controls.handleRefresh} />
      <ImageUpdateButton controls={controls} />
      <KeySettingsMenu onOpenKeyDialog={controls.openKeyDialog} />
    </>
  )
}

function CompactTools({ controls }: { controls: ToolControls }) {
  const throttleProps = {
    config: controls.throttleConfig,
    loading: controls.isLoadingThrottle,
    saving: controls.isSettingThrottle,
    onToggleFailover: controls.handleToggleFailover,
    onChangeCooldown: controls.updateCooldown,
    retryConfig: controls.retryConfig,
    retryLoading: controls.isLoadingRetry,
    retrySaving: controls.isSettingRetry,
    onSaveRetry: controls.updateRetry,
  }

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" title="更多操作" className="relative">
          <MoreHorizontal className="h-4 w-4" />
          {hasUpdate && <UpdateDot />}
        </Button>
      </DropdownMenuTrigger>
      {/* 窄屏兜底：菜单项随调度开关增加时不撑出视口，超出即在菜单内滚动 */}
      <DropdownMenuContent
        align="end"
        className="max-h-[calc(100dvh-4.5rem)] w-56 max-w-[calc(100dvw-1rem)] overflow-x-hidden overflow-y-auto overscroll-contain"
      >
        <DropdownMenuLabel>系统操作</DropdownMenuLabel>
        <DropdownMenuItem
          disabled={controls.isLoadingMode || controls.isSettingMode}
          onSelect={controls.handleToggleLoadBalancing}
        >
          <Activity />
          {controls.isLoadingMode
            ? '负载均衡加载中'
            : `切换到${loadBalancingModeLabel(nextLoadBalancingMode(controls.loadBalancingMode || 'priority'))}`}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onOpenModels}>
          <Boxes />
          可用模型
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onOpenImageUpdate}>
          <UploadCloud />
          镜像在线更新
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function LoadBalancingButton({ controls }: { controls: ToolControls }) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={controls.handleToggleLoadBalancing}
      disabled={controls.isLoadingMode || controls.isSettingMode}
      title={`当前：${loadBalancingModeLabel(controls.loadBalancingMode || 'priority')}，点击切换`}
    >
      <Activity className="h-3.5 w-3.5" />
      <span className="hidden md:inline">
        {controls.isLoadingMode
          ? '加载中…'
          : loadBalancingModeLabel(controls.loadBalancingMode || 'priority')}
      </span>
    </Button>
  )
}

function ModelsButton({ onOpen }: { onOpen: () => void }) {
  return (
    <Button variant="ghost" size="icon" onClick={onOpen} title="可用模型">
      <Boxes className="h-4 w-4" />
    </Button>
  )
}

function RefreshButton({ onRefresh }: { onRefresh: () => void }) {
  return (
    <Button variant="ghost" size="icon" onClick={onRefresh} title="刷新">
      <RefreshCw className="h-4 w-4" />
    </Button>
  )
}

function ImageUpdateButton({ controls }: { controls: ToolControls }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={controls.openImageUpdate}
      title={imageUpdateTitle(controls.updateCheck)}
      className="relative"
    >
      <UploadCloud className="h-4 w-4" />
      {controls.updateCheck?.hasUpdate && <UpdateDot />}
    </Button>
  )
}

function KeySettingsMenu({ onOpenKeyDialog }: { onOpenKeyDialog: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" title="设置">
          <Settings className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>密钥管理</DropdownMenuLabel>
        <DropdownMenuItem onSelect={onOpenKeyDialog}>
          <Key />修改登录API密钥（管理面板登录）
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function imageUpdateTitle(updateCheck: ToolControls['updateCheck']) {
  if (!updateCheck?.hasUpdate) return '镜像在线更新'
  return `发现新版本 v${updateCheck.latestVersion}（当前 v${updateCheck.currentVersion}）`
}

function UpdateDot() {
  return (
    <span className="absolute right-1 top-1 inline-flex h-2 w-2 items-center justify-center">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
    </span>
  )
}

interface ThrottleConfigButtonProps {
  config?: { failover: boolean; cooldownSecs: number }
  loading: boolean
  saving: boolean
  onToggleFailover: () => void
  onChangeCooldown: (secs: number) => void
  retryConfig?: { perCredential: number; total: number }
  retryLoading: boolean
  retrySaving: boolean
  onSaveRetry: (patch: { perCredential: number; total: number }) => void
}

interface ThrottleState {
  cooldownMin: number
  cooldownSecs: number
  failover: boolean
}

interface CustomCooldownFormProps {
  cooldownMin: number
  customMin: string
  disabled: boolean
  onCustomMinChange: (value: string) => void
  onSubmit: (e: React.FormEvent) => void
}

interface ThrottleTriggerProps extends ComponentPropsWithoutRef<typeof Button> {
  loading: boolean
  saving: boolean
  state: ThrottleState
}

const COOLDOWN_PRESETS = [
  { label: '5 分钟', secs: 5 * 60 },
  { label: '15 分钟', secs: 15 * 60 },
  { label: '30 分钟', secs: 30 * 60 },
  { label: '1 小时', secs: 60 * 60 },
  { label: '2 小时', secs: 2 * 60 * 60 },
]

const DEFAULT_COOLDOWN_SECS = 30 * 60
const SECONDS_PER_MINUTE = 60
const MIN_CUSTOM_COOLDOWN_MINUTES = 1
const MAX_CUSTOM_COOLDOWN_MINUTES = 1440

// 重试次数配置的取值范围与默认值（与后端 set_retry_config 校验保持一致）
const RETRY_PER_CREDENTIAL_MIN = 1
const RETRY_PER_CREDENTIAL_MAX = 10
const RETRY_TOTAL_MIN = 1
const RETRY_TOTAL_MAX = 20
const DEFAULT_RETRY_PER_CREDENTIAL = 3
const DEFAULT_RETRY_TOTAL = 4

/**
 * 故障转移开关 + 冷却时长设置（紧凑下拉）
 *
 * 主按钮文案显示当前状态；下拉里:
 * - 顶部一个 Switch 切换 failover
 * - 5 个预设时长 + 一个自定义输入（分钟）
 */
function ThrottleConfigButton({
  config, loading, saving, onToggleFailover, onChangeCooldown,
  retryConfig, retryLoading, retrySaving, onSaveRetry,
}: ThrottleConfigButtonProps) {
  const [open, setOpen] = useState(false)
  const [customMin, setCustomMin] = useState('')
  const state = readThrottleState(config)

  useEffect(() => {
    if (!open) setCustomMin('')
  }, [open])

  const submitCustom = (e: React.FormEvent) => {
    e.preventDefault()
    const min = parseInt(customMin, 10)
    if (invalidCooldownMinutes(min)) {
      toast.error('请输入 1-1440 之间的分钟数')
      return
    }
    onChangeCooldown(min * SECONDS_PER_MINUTE)
    setOpen(false)
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <ThrottleTrigger loading={loading} saving={saving} state={state} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <ThrottleStatusPanel
          saving={saving}
          state={state}
          onToggleFailover={onToggleFailover}
        />
        <ThrottleCooldownPanel
          customMin={customMin}
          saving={saving}
          state={state}
          onChangeCooldown={onChangeCooldown}
          onCustomMinChange={setCustomMin}
          onDone={() => setOpen(false)}
          onSubmitCustom={submitCustom}
        />
        <RetryConfigPanel
          config={retryConfig}
          loading={retryLoading}
          saving={retrySaving}
          onSave={onSaveRetry}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const ThrottleTrigger = forwardRef<HTMLButtonElement, ThrottleTriggerProps>(
  function ThrottleTrigger({ loading, saving, state, ...props }, ref) {
    return (
      <Button
        {...props}
        ref={ref}
        variant="outline"
        size="sm"
        disabled={loading || saving}
        title={throttleTitle(loading, state)}
      >
        {state.failover ? (
          <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
        ) : (
          <ShieldAlert className="h-3.5 w-3.5 text-amber-500" />
        )}
        <span className="hidden md:inline">
          {throttleTriggerText(loading, state)}
        </span>
      </Button>
    )
  },
)

function ThrottleStatusPanel({
  saving, state, onToggleFailover,
}: {
  saving: boolean
  state: ThrottleState
  onToggleFailover: () => void
}) {
  return (
    <>
      <DropdownMenuLabel>账号级风控故障转移</DropdownMenuLabel>
      <div className="px-2 pb-2">
        <div className="flex items-center justify-between gap-2 rounded-md bg-secondary/40 px-2.5 py-2">
          <ThrottleStatusText failover={state.failover} />
          <Switch
            checked={state.failover}
            disabled={saving}
            onCheckedChange={() => onToggleFailover()}
          />
        </div>
      </div>
    </>
  )
}

function ThrottleStatusText({ failover }: { failover: boolean }) {
  return (
    <div className="text-xs">
      <div className="font-medium text-foreground">
        {failover ? '开启' : '关闭'}
      </div>
      <div className="text-muted-foreground leading-snug">
        {failover
          ? '上游对当前账号触发临时限速时，自动冷却该凭据并切换到下一个可用凭据'
          : '上游对当前账号触发临时限速时，仅按瞬态错误重试，不切换凭据'}
      </div>
    </div>
  )
}

function ThrottleCooldownPanel({
  customMin, saving, state, onChangeCooldown, onCustomMinChange, onDone, onSubmitCustom,
}: {
  customMin: string
  saving: boolean
  state: ThrottleState
  onChangeCooldown: (secs: number) => void
  onCustomMinChange: (value: string) => void
  onDone?: () => void
  onSubmitCustom: (e: React.FormEvent) => void
}) {
  const disabled = saving || !state.failover

  return (
    <>
      <DropdownMenuLabel className="pt-1">冷却时长</DropdownMenuLabel>
      <div className={cooldownPanelClassName(state.failover)}>
        <CooldownPresetButtons
          cooldownSecs={state.cooldownSecs}
          disabled={disabled}
          onChangeCooldown={onChangeCooldown}
          onDone={onDone}
        />
        <CustomCooldownForm
          cooldownMin={state.cooldownMin}
          customMin={customMin}
          disabled={disabled}
          onCustomMinChange={onCustomMinChange}
          onSubmit={onSubmitCustom}
        />
      </div>
    </>
  )
}

function CustomCooldownForm({
  cooldownMin, customMin, disabled, onCustomMinChange, onSubmit,
}: CustomCooldownFormProps) {
  return (
    <form onSubmit={onSubmit} className="mt-2 flex items-center gap-1.5">
      <Input
        type="number"
        min={MIN_CUSTOM_COOLDOWN_MINUTES}
        max={MAX_CUSTOM_COOLDOWN_MINUTES}
        placeholder={`自定义（当前 ${cooldownMin}）`}
        value={customMin}
        onChange={(e) => onCustomMinChange(e.target.value)}
        disabled={disabled}
        className="h-7 text-xs"
      />
      <span className="text-xs text-muted-foreground">分钟</span>
      <Button
        type="submit"
        size="sm"
        variant="outline"
        className="h-7 text-xs"
        disabled={disabled || !customMin.trim()}
      >
        保存
      </Button>
    </form>
  )
}

function ThrottleCompactItems(props: ThrottleConfigButtonProps) {
  const {
    loading, saving, onToggleFailover, onChangeCooldown,
    retryConfig, retryLoading, retrySaving, onSaveRetry,
  } = props
  const [customMin, setCustomMin] = useState('')
  const state = readThrottleState(props.config)
  const busy = loading || saving

  const submitCustom = (e: React.FormEvent) => {
    e.preventDefault()
    const min = parseInt(customMin, 10)
    if (invalidCooldownMinutes(min)) {
      toast.error('请输入 1-1440 之间的分钟数')
      return
    }
    onChangeCooldown(min * SECONDS_PER_MINUTE)
    setCustomMin('')
  }

  return (
    <>
      <DropdownMenuLabel>故障转移</DropdownMenuLabel>
      <DropdownMenuItem
        disabled={busy}
        onSelect={onToggleFailover}
      >
        {state.failover ? <ShieldCheck /> : <ShieldAlert />}
        {compactThrottleText(loading, state)}
      </DropdownMenuItem>
      <ThrottleCooldownPanel
        customMin={customMin}
        saving={busy}
        state={state}
        onChangeCooldown={onChangeCooldown}
        onCustomMinChange={setCustomMin}
        onSubmitCustom={submitCustom}
      />
      <RetryConfigPanel
        config={retryConfig}
        loading={retryLoading}
        saving={retrySaving}
        onSave={onSaveRetry}
      />
    </>
  )
}

// ============ 自愈治理 ============

const SELF_HEAL_INTERVAL_PRESETS = [
  { label: '不冷却', secs: 0 },
  { label: '1 分钟', secs: 60 },
  { label: '5 分钟', secs: 5 * 60 },
  { label: '15 分钟', secs: 15 * 60 },
  { label: '30 分钟', secs: 30 * 60 },
]

/**
 * 自愈治理设置（下拉）：
 * - 开关：是否启用凭据自愈
 * - 冷却间隔：两次自愈的最小间隔（打断持续 403 死循环的关键）
 * - 连续上限：连续自愈达到该轮数且期间无成功则停止（0=不限）
 * - 只读观测：凭据最大连续轮数 / 累计恢复凭据次数
 */
function useSelfHealPanelState(resetInput: boolean) {
  const { data: config, isLoading } = useSelfHealConfig()
  const { mutate, isPending } = useSetSelfHealConfig()
  const [roundsInput, setRoundsInput] = useState('')

  useEffect(() => {
    if (resetInput) setRoundsInput('')
  }, [resetInput])

  const enabled = config?.enabled ?? true
  const busy = isLoading || isPending

  const save = (patch: SelfHealConfigPatch, msg: string) => {
    mutate(patch, {
      onSuccess: () => toast.success(msg),
      onError: (err) => toast.error(`保存失败: ${extractErrorMessage(err)}`),
    })
  }

  const submitRounds = (e: React.FormEvent) => {
    e.preventDefault()
    const n = parseInt(roundsInput, 10)
    if (Number.isNaN(n) || n < 0 || n > 1000) {
      toast.error('请输入 0-1000 之间的轮数（0=不限）')
      return
    }
    save({ maxConsecutiveRounds: n }, n === 0 ? '连续自愈已设为不限' : `连续自愈上限已设为 ${n} 轮`)
    setRoundsInput('')
  }

  return {
    busy,
    config,
    enabled,
    isLoading,
    roundsInput,
    save,
    setRoundsInput,
    submitRounds,
  }
}

type SelfHealPanelState = ReturnType<typeof useSelfHealPanelState>

function SelfHealConfigButton() {
  const [open, setOpen] = useState(false)
  const panel = useSelfHealPanelState(!open)

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={panel.busy}
          title={panel.enabled ? '凭据自愈：已启用' : '凭据自愈：已关闭'}
        >
          {panel.enabled ? (
            <HeartPulse className="h-3.5 w-3.5 text-emerald-600" />
          ) : (
            <HeartCrack className="h-3.5 w-3.5 text-amber-500" />
          )}
          <span className="hidden md:inline">
            {panel.isLoading ? '自愈…' : panel.enabled ? '自愈开' : '自愈关'}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <SelfHealConfigPanel {...panel} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function SelfHealConfigPanel({
  busy,
  config,
  enabled,
  roundsInput,
  save,
  setRoundsInput,
  submitRounds,
}: SelfHealPanelState) {
  return (
    <>
      <DropdownMenuLabel>凭据自愈</DropdownMenuLabel>
      <div className="px-2 pb-2">
        <div className="flex items-center justify-between gap-2 rounded-md bg-secondary/40 px-2.5 py-2">
          <div className="min-w-0 text-xs">
            <div className="font-medium">{enabled ? '已启用' : '已关闭'}</div>
            <div className="text-muted-foreground">
              当前请求池全灭时按作用域恢复凭据
            </div>
          </div>
          <Switch
            checked={enabled}
            disabled={busy}
            onCheckedChange={(v) => save({ enabled: v }, v ? '已开启凭据自愈' : '已关闭凭据自愈')}
          />
        </div>
        {config && (
          <div className="mt-2 flex items-center justify-between rounded-md bg-secondary/20 px-2.5 py-1.5 text-xs text-muted-foreground">
            <span>连续 {config.consecutiveRounds} 轮</span>
            <span>累计恢复 {config.totalCount} 次</span>
          </div>
        )}
      </div>

      <DropdownMenuLabel className="pt-1">403 封禁识别</DropdownMenuLabel>
      <div className="px-2 pb-2">
        <div className="flex items-center justify-between gap-2 rounded-md bg-secondary/40 px-2.5 py-2">
          <div className="min-w-0 text-xs">
            <div className="font-medium">
              {config?.suspendedDetectionEnabled ?? true ? '已启用' : '已关闭'}
            </div>
            <div className="text-muted-foreground">
              命中封禁文案的 403 立即禁用，不参与自愈
            </div>
          </div>
          <Switch
            checked={config?.suspendedDetectionEnabled ?? true}
            disabled={busy}
            onCheckedChange={(v) =>
              save({ suspendedDetectionEnabled: v }, v ? '已开启 403 封禁识别' : '已关闭 403 封禁识别')
            }
          />
        </div>
      </div>

      <DropdownMenuLabel className="pt-1">自愈冷却间隔</DropdownMenuLabel>
      <div className={cooldownPanelClassName(enabled)}>
        <div className="grid grid-cols-3 gap-1.5">
          {SELF_HEAL_INTERVAL_PRESETS.map((p) => (
            <Button
              key={p.secs}
              size="sm"
              variant={config?.minIntervalSecs === p.secs ? 'default' : 'outline'}
              className="h-7 text-xs"
              disabled={busy || !enabled}
              onClick={() => save({ minIntervalSecs: p.secs }, `自愈冷却已设为「${p.label}」`)}
            >
              {p.label}
            </Button>
          ))}
        </div>

        <DropdownMenuLabel className="px-0 pt-2">连续自愈上限（0=不限）</DropdownMenuLabel>
        <form onSubmit={submitRounds} className="mt-1 flex items-center gap-1.5">
          <Input
            type="number"
            min={0}
            max={1000}
            placeholder={`当前 ${config?.maxConsecutiveRounds ?? 5} 轮`}
            value={roundsInput}
            onChange={(e) => setRoundsInput(e.target.value)}
            disabled={busy || !enabled}
            className="h-7 min-w-0 text-xs"
          />
          <span className="text-xs text-muted-foreground">轮</span>
          <Button
            type="submit"
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled={busy || !enabled || !roundsInput.trim()}
          >
            保存
          </Button>
        </form>
      </div>
    </>
  )
}

/** 紧凑菜单复用完整配置，避免移动端丢失治理选项。 */
function SelfHealCompactItems() {
  const panel = useSelfHealPanelState(false)
  return <SelfHealConfigPanel {...panel} />
}

const RPM_LIMIT_PRESETS = [10, 30, 60, 120, 300]
const MIN_RPM_LIMIT = 1
const MAX_RPM_LIMIT = 100000

/**
 * 单账号 RPM 主动限流：开关 + 每分钟上限设置（紧凑下拉）。
 *
 * 开启后每个账号独立维护 60 秒滑动窗口，达到上限时该账号被临时排除出候选，
 * 请求自动故障转移到下一个可用账号；全部超限时返回 429。
 */
function useAccountRpmLimitPanelState(resetInput: boolean) {
  const { data: config, isLoading } = useAccountRpmLimitConfig()
  const { mutate, isPending } = useSetAccountRpmLimitConfig()
  const [limitInput, setLimitInput] = useState('')

  useEffect(() => {
    if (resetInput) setLimitInput('')
  }, [resetInput])

  const enabled = config?.enabled ?? false
  const limit = config?.limit ?? 60
  const busy = isLoading || isPending

  const save = (patch: { enabled?: boolean; limit?: number }, msg: string) => {
    mutate(patch, {
      onSuccess: () => toast.success(msg),
      onError: (err) => toast.error(`保存失败: ${extractErrorMessage(err)}`),
    })
  }

  const submitLimit = (e: React.FormEvent) => {
    e.preventDefault()
    const n = parseInt(limitInput, 10)
    if (Number.isNaN(n) || n < MIN_RPM_LIMIT || n > MAX_RPM_LIMIT) {
      toast.error(`请输入 ${MIN_RPM_LIMIT}-${MAX_RPM_LIMIT} 之间的次数`)
      return
    }
    save({ limit: n }, `单账号 RPM 上限已设为 ${n} 次/分钟`)
    setLimitInput('')
  }

  return {
    busy,
    config,
    enabled,
    isLoading,
    limit,
    limitInput,
    save,
    setLimitInput,
    submitLimit,
  }
}

type AccountRpmLimitPanelState = ReturnType<typeof useAccountRpmLimitPanelState>

function AccountRpmLimitButton() {
  const [open, setOpen] = useState(false)
  const panel = useAccountRpmLimitPanelState(!open)

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={panel.busy}
          title={panel.enabled ? `单账号限流：${panel.limit} 次/分钟` : '单账号限流：已关闭'}
        >
          <Gauge className={panel.enabled ? 'h-3.5 w-3.5 text-emerald-600' : 'h-3.5 w-3.5 text-muted-foreground'} />
          <span className="hidden md:inline">
            {panel.isLoading ? '限流…' : panel.enabled ? `限流 ${panel.limit}/分` : '限流关'}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <AccountRpmLimitPanel {...panel} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function AccountRpmLimitPanel({
  busy,
  enabled,
  limit,
  limitInput,
  save,
  setLimitInput,
  submitLimit,
}: AccountRpmLimitPanelState) {
  return (
    <>
      <DropdownMenuLabel>单账号每分钟请求限流</DropdownMenuLabel>
      <div className="px-2 pb-2">
        <div className="flex items-center justify-between gap-2 rounded-md bg-secondary/40 px-2.5 py-2">
          <div className="min-w-0 text-xs">
            <div className="font-medium">{enabled ? '已启用' : '已关闭'}</div>
            <div className="text-muted-foreground leading-snug">
              单账号超过每分钟上限时临时跳过并切换到下一个可用账号
            </div>
          </div>
          <Switch
            checked={enabled}
            disabled={busy}
            onCheckedChange={(v) => save({ enabled: v }, v ? '已开启单账号限流' : '已关闭单账号限流')}
          />
        </div>
      </div>

      <DropdownMenuLabel className="pt-1">每分钟上限</DropdownMenuLabel>
      <div className={cooldownPanelClassName(enabled)}>
        <div className="grid grid-cols-3 gap-1.5">
          {RPM_LIMIT_PRESETS.map((n) => (
            <Button
              key={n}
              size="sm"
              variant={limit === n ? 'default' : 'outline'}
              className="h-7 text-xs"
              disabled={busy || !enabled}
              onClick={() => save({ limit: n }, `单账号 RPM 上限已设为 ${n} 次/分钟`)}
            >
              {n}
            </Button>
          ))}
        </div>

        <DropdownMenuLabel className="px-0 pt-2">自定义（次/分钟）</DropdownMenuLabel>
        <form onSubmit={submitLimit} className="mt-1 flex items-center gap-1.5">
          <Input
            type="number"
            min={MIN_RPM_LIMIT}
            max={MAX_RPM_LIMIT}
            placeholder={`当前 ${limit} 次`}
            value={limitInput}
            onChange={(e) => setLimitInput(e.target.value)}
            disabled={busy || !enabled}
            className="h-7 min-w-0 text-xs"
          />
          <span className="text-xs text-muted-foreground">次</span>
          <Button
            type="submit"
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled={busy || !enabled || !limitInput.trim()}
          >
            保存
          </Button>
        </form>
      </div>
    </>
  )
}

/** 紧凑菜单复用完整配置，避免移动端只能切换开关。 */
function AccountRpmLimitCompactItems() {
  const panel = useAccountRpmLimitPanelState(false)
  return <AccountRpmLimitPanel {...panel} />
}

function CooldownPresetButtons({
  cooldownSecs, disabled, onChangeCooldown, onDone,
}: {
  cooldownSecs: number
  disabled: boolean
  onChangeCooldown: (secs: number) => void
  onDone?: () => void
}) {
  return (
    <div className="grid grid-cols-3 gap-1">
      {COOLDOWN_PRESETS.map((preset) => (
        <CooldownPresetButton
          key={preset.secs}
          active={preset.secs === cooldownSecs}
          disabled={disabled}
          label={preset.label}
          secs={preset.secs}
          onChangeCooldown={onChangeCooldown}
          onDone={onDone}
        />
      ))}
    </div>
  )
}

function CooldownPresetButton({
  active, disabled, label, secs, onChangeCooldown, onDone,
}: {
  active: boolean
  disabled: boolean
  label: string
  secs: number
  onChangeCooldown: (secs: number) => void
  onDone?: () => void
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={active ? 'default' : 'outline'}
      className="h-7 text-xs"
      disabled={disabled}
      onClick={() => {
        if (!active) onChangeCooldown(secs)
        onDone?.()
      }}
    >
      {label}
    </Button>
  )
}

function secondsToMinutes(seconds: number) {
  return Math.round(seconds / SECONDS_PER_MINUTE)
}

function readThrottleState(
  config: ThrottleConfigButtonProps['config'],
): ThrottleState {
  const cooldownSecs = config?.cooldownSecs ?? DEFAULT_COOLDOWN_SECS
  return {
    cooldownMin: secondsToMinutes(cooldownSecs),
    cooldownSecs,
    failover: config?.failover ?? true,
  }
}

function throttleTitle(loading: boolean, state: ThrottleState) {
  if (loading) return '加载中…'
  if (!state.failover) return '账号级风控故障转移：关闭'
  return `账号级风控故障转移：开启（冷却 ${state.cooldownMin} 分钟）`
}

function throttleTriggerText(loading: boolean, state: ThrottleState) {
  if (loading) return '加载中…'
  if (!state.failover) return '不切换'
  return `故障转移 · ${state.cooldownMin}m`
}

function compactThrottleText(loading: boolean, state: ThrottleState) {
  if (loading) return '故障转移加载中'
  if (!state.failover) return '开启故障转移'
  return `关闭故障转移 · ${state.cooldownMin}m`
}

function invalidCooldownMinutes(minutes: number) {
  return (
    Number.isNaN(minutes) ||
    minutes < MIN_CUSTOM_COOLDOWN_MINUTES ||
    minutes > MAX_CUSTOM_COOLDOWN_MINUTES
  )
}

function cooldownPanelClassName(failover: boolean) {
  return `px-2 pb-2 ${failover ? '' : 'opacity-60'}`
}

interface RetryConfigPanelProps {
  config?: { perCredential: number; total: number }
  loading: boolean
  saving: boolean
  onSave: (patch: { perCredential: number; total: number }) => void
}

/**
 * 重试次数设置面板（每凭据重试次数 + 单次请求总重试上限）。
 *
 * 实际重试次数 = min(分组内账号数 × 每凭据次数, 总上限)。两个输入默认留空、
 * placeholder 显示当前值；留空表示不改该项，点「保存」一次性提交。
 */
function RetryConfigPanel({ config, loading, saving, onSave }: RetryConfigPanelProps) {
  const curPer = config?.perCredential ?? DEFAULT_RETRY_PER_CREDENTIAL
  const curTotal = config?.total ?? DEFAULT_RETRY_TOTAL
  const [perStr, setPerStr] = useState('')
  const [totalStr, setTotalStr] = useState('')
  const busy = loading || saving

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!perStr.trim() && !totalStr.trim()) {
      toast.error('请至少填写一个要修改的值')
      return
    }
    const per = perStr.trim() ? parseInt(perStr, 10) : curPer
    const total = totalStr.trim() ? parseInt(totalStr, 10) : curTotal
    if (invalidRange(per, RETRY_PER_CREDENTIAL_MIN, RETRY_PER_CREDENTIAL_MAX)) {
      toast.error(`每凭据重试次数需在 ${RETRY_PER_CREDENTIAL_MIN}-${RETRY_PER_CREDENTIAL_MAX} 之间`)
      return
    }
    if (invalidRange(total, RETRY_TOTAL_MIN, RETRY_TOTAL_MAX)) {
      toast.error(`总重试上限需在 ${RETRY_TOTAL_MIN}-${RETRY_TOTAL_MAX} 之间`)
      return
    }
    onSave({ perCredential: per, total })
    setPerStr('')
    setTotalStr('')
  }

  return (
    <>
      <DropdownMenuLabel className="pt-1">
        失败重试次数{loading ? '（加载中…）' : ` · 当前 ${curPer} / 上限 ${curTotal}`}
      </DropdownMenuLabel>
      <form onSubmit={submit} className="space-y-1.5 px-2 pb-2">
        <RetryNumberField
          label="每凭据"
          min={RETRY_PER_CREDENTIAL_MIN}
          max={RETRY_PER_CREDENTIAL_MAX}
          current={curPer}
          value={perStr}
          disabled={busy}
          onChange={setPerStr}
        />
        <RetryNumberField
          label="总上限"
          min={RETRY_TOTAL_MIN}
          max={RETRY_TOTAL_MAX}
          current={curTotal}
          value={totalStr}
          disabled={busy}
          onChange={setTotalStr}
        />
        <Button
          type="submit"
          size="sm"
          variant="outline"
          className="h-7 w-full text-xs"
          disabled={busy || (!perStr.trim() && !totalStr.trim())}
        >
          保存重试次数
        </Button>
      </form>
    </>
  )
}

function RetryNumberField({
  label, min, max, current, value, disabled, onChange,
}: {
  label: string
  min: number
  max: number
  current: number
  value: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-12 shrink-0 text-xs text-muted-foreground">{label}</span>
      <Input
        type="number"
        min={min}
        max={max}
        placeholder={`当前 ${current}（${min}-${max}）`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="h-7 text-xs"
      />
    </div>
  )
}

function invalidRange(value: number, min: number, max: number) {
  return Number.isNaN(value) || value < min || value > max
}
