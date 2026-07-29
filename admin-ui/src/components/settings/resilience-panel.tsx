import { useState } from 'react'
import { toast } from 'sonner'
import { ShieldAlert, ShieldCheck, HeartPulse, HeartCrack, RotateCcw } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  useAccountThrottleConfig, useSetAccountThrottleConfig,
  useRetryConfig, useSetRetryConfig,
  useSelfHealConfig, useSetSelfHealConfig,
} from '@/hooks/use-credentials'
import { type SelfHealConfigPatch } from '@/api/credentials'
import { extractErrorMessage } from '@/lib/utils'

/**
 * 风控与重试面板：账号级风控故障转移、失败重试次数、凭据自愈。
 *
 * 这三块原先分别挤在顶栏的两个下拉菜单里（重试次数还嵌在风控下拉的第三层），
 * 输入框只有 h-7、说明文字被压成一行。这里铺开成三张卡片。
 */
const COOLDOWN_PRESETS = [
  { label: '5 分钟', secs: 5 * 60 },
  { label: '15 分钟', secs: 15 * 60 },
  { label: '30 分钟', secs: 30 * 60 },
  { label: '1 小时', secs: 60 * 60 },
  { label: '2 小时', secs: 2 * 60 * 60 },
]

const SELF_HEAL_INTERVAL_PRESETS = [
  { label: '不冷却', secs: 0 },
  { label: '1 分钟', secs: 60 },
  { label: '5 分钟', secs: 5 * 60 },
  { label: '15 分钟', secs: 15 * 60 },
  { label: '30 分钟', secs: 30 * 60 },
]

const DEFAULT_COOLDOWN_SECS = 30 * 60
const SECONDS_PER_MINUTE = 60
const MIN_CUSTOM_COOLDOWN_MINUTES = 1
const MAX_CUSTOM_COOLDOWN_MINUTES = 1440

// 重试次数取值范围与默认值（与后端 set_retry_config 校验保持一致）
const RETRY_PER_CREDENTIAL_MIN = 1
const RETRY_PER_CREDENTIAL_MAX = 10
const RETRY_TOTAL_MIN = 1
const RETRY_TOTAL_MAX = 20
const DEFAULT_RETRY_PER_CREDENTIAL = 3
const DEFAULT_RETRY_TOTAL = 4

const MAX_SELF_HEAL_ROUNDS = 1000
const DEFAULT_SELF_HEAL_ROUNDS = 5

export function ResiliencePanel() {
  return (
    <div className="space-y-3">
      <ThrottleCard />
      <RetryCard />
      <SelfHealCard />
    </div>
  )
}

/** 面板内统一的小标题 + 说明 */
function PanelHeading({
  title,
  desc,
  icon,
}: {
  title: string
  desc: string
  icon?: React.ReactNode
}) {
  return (
    <div>
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        {icon}
        {title}
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{desc}</p>
    </div>
  )
}

/** 开关行：左侧状态文案 + 右侧 Switch */
function ToggleRow({
  checked,
  disabled,
  title,
  desc,
  onChange,
}: {
  checked: boolean
  disabled: boolean
  title: string
  desc: string
  onChange: (next: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-secondary/40 px-3 py-2.5">
      <div className="min-w-0 text-xs">
        <div className="font-medium text-foreground">{title}</div>
        <div className="mt-0.5 leading-snug text-muted-foreground">{desc}</div>
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  )
}

/** 预设时长按钮组 */
function PresetRow({
  presets,
  current,
  disabled,
  onSelect,
}: {
  presets: { label: string; secs: number }[]
  current: number
  disabled: boolean
  onSelect: (secs: number) => void
}) {
  return (
    <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5">
      {presets.map((p) => (
        <Button
          key={p.secs}
          size="sm"
          variant={current === p.secs ? 'default' : 'outline'}
          className="h-8 text-xs"
          disabled={disabled}
          onClick={() => current !== p.secs && onSelect(p.secs)}
        >
          {p.label}
        </Button>
      ))}
    </div>
  )
}

function invalidRange(value: number, min: number, max: number) {
  return Number.isNaN(value) || value < min || value > max
}

// ============ 账号级风控故障转移 ============

function ThrottleCard() {
  const { data: config, isLoading } = useAccountThrottleConfig()
  const { mutate, isPending } = useSetAccountThrottleConfig()
  const [customMin, setCustomMin] = useState('')

  const failover = config?.failover ?? true
  const cooldownSecs = config?.cooldownSecs ?? DEFAULT_COOLDOWN_SECS
  const cooldownMin = Math.round(cooldownSecs / SECONDS_PER_MINUTE)
  const busy = isLoading || isPending

  const saveCooldown = (secs: number) => {
    mutate(
      { cooldownSecs: secs },
      {
        onSuccess: () => toast.success(`冷却时长已设为 ${Math.round(secs / SECONDS_PER_MINUTE)} 分钟`),
        onError: (err) => toast.error(`保存失败: ${extractErrorMessage(err)}`),
      },
    )
  }

  const submitCustom = (e: React.FormEvent) => {
    e.preventDefault()
    const min = parseInt(customMin, 10)
    if (invalidRange(min, MIN_CUSTOM_COOLDOWN_MINUTES, MAX_CUSTOM_COOLDOWN_MINUTES)) {
      toast.error(`请输入 ${MIN_CUSTOM_COOLDOWN_MINUTES}-${MAX_CUSTOM_COOLDOWN_MINUTES} 之间的分钟数`)
      return
    }
    saveCooldown(min * SECONDS_PER_MINUTE)
    setCustomMin('')
  }

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <PanelHeading
          icon={
            failover ? (
              <ShieldCheck className="h-4 w-4 text-emerald-600" />
            ) : (
              <ShieldAlert className="h-4 w-4 text-amber-500" />
            )
          }
          title="账号级风控故障转移"
          desc="上游对单个账号触发临时限速（429）时，是否冷却该凭据并切换到下一个可用凭据。"
        />

        <ToggleRow
          checked={failover}
          disabled={busy}
          title={isLoading ? '加载中…' : failover ? '已开启' : '已关闭'}
          desc={
            failover
              ? '触发限速时自动冷却该凭据并切换'
              : '触发限速时仅按瞬态错误重试，不切换凭据'
          }
          onChange={(next) =>
            mutate(
              { failover: next },
              {
                onSuccess: () =>
                  toast.success(next ? '已开启账号级风控故障转移' : '已关闭账号级风控故障转移'),
                onError: (err) => toast.error(`切换失败: ${extractErrorMessage(err)}`),
              },
            )
          }
        />

        <div className={failover ? '' : 'opacity-60'}>
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">
            冷却时长 · 当前 {cooldownMin} 分钟
          </div>
          <PresetRow
            presets={COOLDOWN_PRESETS}
            current={cooldownSecs}
            disabled={busy || !failover}
            onSelect={saveCooldown}
          />
          <form onSubmit={submitCustom} className="mt-2 flex items-center gap-2">
            <Input
              type="number"
              min={MIN_CUSTOM_COOLDOWN_MINUTES}
              max={MAX_CUSTOM_COOLDOWN_MINUTES}
              placeholder={`自定义（${MIN_CUSTOM_COOLDOWN_MINUTES}-${MAX_CUSTOM_COOLDOWN_MINUTES}）`}
              value={customMin}
              onChange={(e) => setCustomMin(e.target.value)}
              disabled={busy || !failover}
              className="h-8 text-xs"
            />
            <span className="shrink-0 text-xs text-muted-foreground">分钟</span>
            <Button
              type="submit"
              size="sm"
              variant="outline"
              className="h-8 shrink-0 text-xs"
              disabled={busy || !failover || !customMin.trim()}
            >
              保存
            </Button>
          </form>
        </div>
      </CardContent>
    </Card>
  )
}

// ============ 失败重试次数 ============

/**
 * 实际重试次数 = min(分组内账号数 × 每凭据次数, 总上限)。
 * 两个输入默认留空、placeholder 显示当前值；留空表示不改该项。
 */
function RetryCard() {
  const { data: config, isLoading } = useRetryConfig()
  const { mutate, isPending } = useSetRetryConfig()
  const [perStr, setPerStr] = useState('')
  const [totalStr, setTotalStr] = useState('')

  const curPer = config?.perCredential ?? DEFAULT_RETRY_PER_CREDENTIAL
  const curTotal = config?.total ?? DEFAULT_RETRY_TOTAL
  const busy = isLoading || isPending

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
    mutate(
      { perCredential: per, total },
      {
        onSuccess: () => {
          toast.success(`重试次数已更新（每凭据 ${per} · 上限 ${total}）`)
          setPerStr('')
          setTotalStr('')
        },
        onError: (err) => toast.error(`保存失败: ${extractErrorMessage(err)}`),
      },
    )
  }

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <PanelHeading
          icon={<RotateCcw className="h-4 w-4 text-muted-foreground" />}
          title={`失败重试次数${isLoading ? '（加载中…）' : ` · 每凭据 ${curPer} / 上限 ${curTotal}`}`}
          desc="实际重试次数 = min(分组内账号数 × 每凭据次数, 总上限)。留空表示不修改该项。"
        />

        <form onSubmit={submit} className="space-y-2">
          <NumberField
            label="每凭据"
            min={RETRY_PER_CREDENTIAL_MIN}
            max={RETRY_PER_CREDENTIAL_MAX}
            current={curPer}
            value={perStr}
            disabled={busy}
            onChange={setPerStr}
          />
          <NumberField
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
            className="h-8 text-xs"
            disabled={busy || (!perStr.trim() && !totalStr.trim())}
          >
            保存重试次数
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

function NumberField({
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
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-xs text-muted-foreground">{label}</span>
      <Input
        type="number"
        min={min}
        max={max}
        placeholder={`当前 ${current}（${min}-${max}）`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="h-8 max-w-xs text-xs"
      />
    </div>
  )
}

// ============ 凭据自愈 ============

/**
 * 自愈治理：自愈开关、403 封禁识别、冷却间隔、连续上限，外加两个只读观测值
 * （凭据最大连续轮数 / 累计恢复次数）。
 */
function SelfHealCard() {
  const { data: config, isLoading } = useSelfHealConfig()
  const { mutate, isPending } = useSetSelfHealConfig()
  const [roundsInput, setRoundsInput] = useState('')

  const enabled = config?.enabled ?? true
  const suspendedDetection = config?.suspendedDetectionEnabled ?? true
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
    if (invalidRange(n, 0, MAX_SELF_HEAL_ROUNDS)) {
      toast.error(`请输入 0-${MAX_SELF_HEAL_ROUNDS} 之间的轮数（0=不限）`)
      return
    }
    save(
      { maxConsecutiveRounds: n },
      n === 0 ? '连续自愈已设为不限' : `连续自愈上限已设为 ${n} 轮`,
    )
    setRoundsInput('')
  }

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <PanelHeading
          icon={
            enabled ? (
              <HeartPulse className="h-4 w-4 text-emerald-600" />
            ) : (
              <HeartCrack className="h-4 w-4 text-amber-500" />
            )
          }
          title="凭据自愈"
          desc="当前请求池全部凭据不可用时，按作用域临时恢复被自动禁用的凭据继续尝试。"
        />

        <ToggleRow
          checked={enabled}
          disabled={busy}
          title={isLoading ? '加载中…' : enabled ? '已启用' : '已关闭'}
          desc="请求池全灭时按作用域恢复凭据"
          onChange={(v) => save({ enabled: v }, v ? '已开启凭据自愈' : '已关闭凭据自愈')}
        />

        {config && (
          <div className="flex items-center justify-between rounded-md bg-secondary/20 px-3 py-2 text-xs text-muted-foreground">
            <span>当前连续 {config.consecutiveRounds} 轮</span>
            <span>累计恢复 {config.totalCount} 次</span>
          </div>
        )}

        <ToggleRow
          checked={suspendedDetection}
          disabled={busy}
          title={`403 封禁识别：${suspendedDetection ? '已启用' : '已关闭'}`}
          desc="命中封禁文案的 403 立即禁用该凭据，且不参与自愈；需人工核实后手动重置"
          onChange={(v) =>
            save(
              { suspendedDetectionEnabled: v },
              v ? '已开启 403 封禁识别' : '已关闭 403 封禁识别',
            )
          }
        />

        <div className={enabled ? '' : 'opacity-60'}>
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">
            自愈冷却间隔 · 两次自愈的最小间隔
          </div>
          <PresetRow
            presets={SELF_HEAL_INTERVAL_PRESETS}
            current={config?.minIntervalSecs ?? 0}
            disabled={busy || !enabled}
            onSelect={(secs) => {
              const label = SELF_HEAL_INTERVAL_PRESETS.find((p) => p.secs === secs)?.label ?? ''
              save({ minIntervalSecs: secs }, `自愈冷却已设为「${label}」`)
            }}
          />

          <form onSubmit={submitRounds} className="mt-2 flex items-center gap-2">
            <span className="shrink-0 text-xs text-muted-foreground">连续上限</span>
            <Input
              type="number"
              min={0}
              max={MAX_SELF_HEAL_ROUNDS}
              placeholder={`当前 ${config?.maxConsecutiveRounds ?? DEFAULT_SELF_HEAL_ROUNDS} 轮（0=不限）`}
              value={roundsInput}
              onChange={(e) => setRoundsInput(e.target.value)}
              disabled={busy || !enabled}
              className="h-8 text-xs"
            />
            <span className="shrink-0 text-xs text-muted-foreground">轮</span>
            <Button
              type="submit"
              size="sm"
              variant="outline"
              className="h-8 shrink-0 text-xs"
              disabled={busy || !enabled || !roundsInput.trim()}
            >
              保存
            </Button>
          </form>
        </div>
      </CardContent>
    </Card>
  )
}
