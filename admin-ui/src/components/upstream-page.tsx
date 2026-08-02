import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  PackagePlus,
  Plus,
  Trash2,
  Pencil,
  Wallet,
  KeyRound,
  Webhook,
  RefreshCw,
  RotateCcw,
  Loader2,
  Info,
  Copy,
  Zap,
  CheckCircle2,
  XCircle,
  AlertCircle,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { GroupMultiSelect } from '@/components/group-select'
import { useGroupOptions } from '@/hooks/use-groups'
import {
  useUpstreams,
  useUpstreamEvents,
  useCreateUpstream,
  useUpdateUpstream,
  useDeleteUpstream,
} from '@/hooks/use-upstream'
import {
  queryUpstreamStock,
  queryUpstreamProfile,
  purchaseUpstream,
  registerUpstreamWebhook,
  testUpstreamWebhook,
  resetUpstreamPickupTotal,
  queryUpstreamCreatedAt,
  queryUpstreamOrders,
  queryUpstreamStatus,
  type UpstreamConfig,
  type UpstreamProfile,
  type UpstreamEvent,
  type KeysCreatedAt,
  type UpstreamOrder,
  type PurchaseSchedule,
  type PeakWindow,
  type PickupStats,
  type UpstreamPlatform,
  type KiroCeoZone,
  type StockZone,
  PLATFORM_DEFAULT_BASE_URL,
  PLATFORM_LABEL,
  supportsWebhook,
  canRegisterWebhook,
  isDirectKeyWebhook,
  balanceLabel,
} from '@/api/upstream'
import { extractErrorMessage } from '@/lib/utils'

/** 提货量展示：0 = 提满 */
function fmtCount(n: number): string {
  return n > 0 ? `×${n}` : '提满'
}

type UpstreamQueryResult = UpstreamProfile & {
  max?: number
  keyPrice?: number
  priceMax?: number
  zones?: StockZone[]
}

interface EditState {
  id?: string
  name: string
  platform: UpstreamPlatform
  baseUrl: string
  apiKey: string
  receiverBaseUrl: string
  webhookSecret: string
  webhookSecretEnabled: boolean
  webhookSecretSet: boolean
  autoPurchaseEnabled: boolean
  autoPurchaseCount: string
  // 分时段：多条高峰规则 + 高峰/低谷两档
  scheduleEnabled: boolean
  peakWindows: PeakWindow[]
  peakCount: string
  offpeakCount: string
  endpoint: string
  groups: string[]
  note: string
}

const emptyEdit: EditState = {
  name: '',
  platform: 'legacy',
  baseUrl: '',
  apiKey: '',
  receiverBaseUrl: '',
  webhookSecret: '',
  webhookSecretEnabled: false,
  webhookSecretSet: false,
  autoPurchaseEnabled: false,
  autoPurchaseCount: '0',
  scheduleEnabled: false,
  peakWindows: [],
  peakCount: '0',
  offpeakCount: '0',
  endpoint: '',
  groups: [],
  note: '',
}

/** 星期几标签（0=周日…6=周六，与 JS Date.getDay 一致） */
const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六']

/**
 * 补货上游管理页（Tab）。
 *
 * 基础能力：上游 CRUD（URL + usr-key）、查询余额/库存、手动提号入库、
 * 配置自动提号（低消：收到 new_keys_available 自动提）、注册/测试 Webhook、事件日志。
 */
export function UpstreamPage() {
  const { data: upstreams, isLoading, isFetching, refetch } = useUpstreams()
  const { data: eventsData, refetch: refetchEvents } = useUpstreamEvents()
  const events = eventsData?.events ?? []
  const stats = eventsData?.stats
  const createUpstream = useCreateUpstream()
  const updateUpstream = useUpdateUpstream()
  const deleteUpstream = useDeleteUpstream()
  const confirm = useConfirm()
  const groupOptions = useGroupOptions()

  const [editOpen, setEditOpen] = useState(false)
  const [edit, setEdit] = useState<EditState>(emptyEdit)

  // 余额 / 库存缓存：id → 结果
  const [profiles, setProfiles] = useState<
    Record<string, UpstreamQueryResult>
  >({})
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [purchasingId, setPurchasingId] = useState<string | null>(null)
  const [resettingId, setResettingId] = useState<string | null>(null)

  const list = upstreams ?? []

  const openCreate = () => {
    setEdit(emptyEdit)
    setEditOpen(true)
  }

  const openEdit = (u: UpstreamConfig) => {
    const s = u.schedule
    setEdit({
      id: u.id,
      name: u.name,
      platform: u.platform,
      baseUrl: u.baseUrl,
      apiKey: '', // 不回填明文，留空表示不改
      receiverBaseUrl: u.receiverBaseUrl ?? '',
      webhookSecret: '',
      webhookSecretEnabled: u.webhookSecretSet,
      webhookSecretSet: u.webhookSecretSet,
      autoPurchaseEnabled: u.autoPurchaseEnabled,
      autoPurchaseCount: String(u.autoPurchaseCount),
      scheduleEnabled: s?.enabled ?? false,
      peakWindows: s?.peakWindows ?? [],
      peakCount: String(s?.peakCount ?? 0),
      offpeakCount: String(s?.offpeakCount ?? 0),
      endpoint: u.endpoint ?? '',
      groups: u.groups ?? [],
      note: u.note ?? '',
    })
    setEditOpen(true)
  }

  const handleSave = async () => {
    if (!edit.name.trim()) {
      toast.error('上游名称不能为空')
      return
    }
    const count = parseInt(edit.autoPurchaseCount, 10)
    const toCount = (s: string) => {
      const n = parseInt(s, 10)
      return Number.isNaN(n) || n < 0 ? 0 : n
    }
    const directKeyWebhook = isDirectKeyWebhook(edit.platform)
    if (directKeyWebhook) {
      try {
        if (new URL(edit.receiverBaseUrl.trim()).protocol !== 'https:') throw new Error()
      } catch {
        toast.error('Kiro API Key 通知必须配置有效的 HTTPS 对外地址')
        return
      }
      if (edit.webhookSecretEnabled && !edit.webhookSecretSet && !edit.webhookSecret.trim()) {
        toast.error('已开启 Secret 校验，请填写 Secret')
        return
      }
    }
    // 校验：开启分时段但没配任何高峰规则
    if (supportsWebhook(edit.platform) && edit.scheduleEnabled && edit.peakWindows.length === 0) {
      toast.error('已开启分时段，请至少添加一条高峰时段规则')
      return
    }
    const schedule: PurchaseSchedule = {
      enabled: edit.scheduleEnabled,
      peakWindows: edit.peakWindows,
      peakCount: toCount(edit.peakCount),
      offpeakCount: toCount(edit.offpeakCount),
    }
    const req = {
      name: edit.name.trim(),
      platform: edit.platform,
      baseUrl: directKeyWebhook
        ? ''
        : edit.baseUrl.trim() || PLATFORM_DEFAULT_BASE_URL[edit.platform],
      // Kiro Market 也收 webhook，回调地址与自动提号对它同样有效
      receiverBaseUrl: supportsWebhook(edit.platform)
        ? edit.receiverBaseUrl.trim() || null
        : null,
      webhookSecret: directKeyWebhook
        ? edit.webhookSecretEnabled
          ? edit.webhookSecret.trim() || undefined
          : null
        : null,
      autoPurchaseEnabled:
        !directKeyWebhook && supportsWebhook(edit.platform) && edit.autoPurchaseEnabled,
      autoPurchaseCount: Number.isNaN(count) || count < 0 ? 0 : count,
      schedule,
      endpoint: edit.endpoint.trim() || null,
      groups: edit.groups,
      note: edit.note.trim() || null,
    }
    try {
      if (edit.id) {
        await updateUpstream.mutateAsync({
          id: edit.id,
          req: { ...req, apiKey: edit.apiKey.trim() || undefined },
        })
        toast.success('上游已更新')
      } else {
        if (!directKeyWebhook && !edit.apiKey.trim()) {
          toast.error('上游 API Key 不能为空')
          return
        }
        await createUpstream.mutateAsync({
          ...req,
          apiKey: directKeyWebhook ? '' : edit.apiKey.trim(),
        })
        toast.success('上游已添加')
      }
      setEditOpen(false)
    } catch (e) {
      toast.error(extractErrorMessage(e))
    }
  }

  const handleDelete = async (u: UpstreamConfig) => {
    if (
      !(await confirm({
        title: `删除上游 ${u.name}？`,
        description: '仅删除本地配置，不影响已入库的凭据。',
        confirmText: '删除',
        destructive: true,
      }))
    )
      return
    try {
      await deleteUpstream.mutateAsync(u.id)
      toast.success(`上游 ${u.name} 已删除`)
    } catch (e) {
      toast.error(extractErrorMessage(e))
    }
  }

  const handleResetPickupTotal = async (u: UpstreamConfig) => {
    if (
      !(await confirm({
        title: `重置 ${u.name} 的累计取货？`,
        description: `当前累计为 ${u.pickupTotal} 个。重置后从 0 重新计算，历史事件不会删除。`,
        confirmText: '重置累计',
        destructive: true,
      }))
    )
      return
    setResettingId(u.id)
    try {
      const result = await resetUpstreamPickupTotal(u.id)
      await Promise.all([refetch(), refetchEvents()])
      toast.success(`已重置 ${u.name} 的累计取货（重置前 ${result.previousTotal} 个）`)
    } catch (e) {
      toast.error('重置失败: ' + extractErrorMessage(e))
    } finally {
      setResettingId(null)
    }
  }

  // 查询余额 + 库存（并发两个请求）
  const handleQuery = async (u: UpstreamConfig) => {
    setLoadingId(u.id)
    try {
      const [profile, stock] = await Promise.allSettled([
        queryUpstreamProfile(u.id),
        queryUpstreamStock(u.id),
      ])
      const merged: UpstreamQueryResult = {}
      if (profile.status === 'fulfilled') Object.assign(merged, profile.value)
      if (stock.status === 'fulfilled') {
        merged.max = stock.value.max
        merged.keyPrice = stock.value.keyPrice
        merged.priceMax = stock.value.priceMax
        merged.zones = stock.value.zones
        // Kiro Market 的 stock 自带余额：profile 失败时也能显示余额
        if (merged.remaining == null && stock.value.balance != null) {
          merged.remaining = stock.value.balance
        }
      }
      setProfiles((prev) => ({ ...prev, [u.id]: merged }))
      if (profile.status === 'rejected' && stock.status === 'rejected') {
        toast.error('查询失败: ' + extractErrorMessage(stock.reason))
      } else {
        const zoneSummary =
          u.platform === 'kiro_ceo' && merged.zones?.length
            ? merged.zones.map((zone) => `${zone.zone.toUpperCase()} ${zone.max}`).join(' / ')
            : `${merged.max ?? '-'} 个`
        toast.success(
          `${u.name}：${balanceLabel(u.platform)} ${merged.remaining ?? '-'}，可提取 ${zoneSummary}`,
        )
      }
    } finally {
      setLoadingId(null)
    }
  }

  // 手动提号：必须指定数量（弹窗输入）
  const [purchaseTarget, setPurchaseTarget] = useState<UpstreamConfig | null>(null)
  const [purchaseCount, setPurchaseCount] = useState('')
  const [purchaseZone, setPurchaseZone] = useState<KiroCeoZone>('us')

  const openPurchase = (u: UpstreamConfig) => {
    setPurchaseTarget(u)
    setPurchaseCount('')
    setPurchaseZone('us')
  }

  const handlePurchase = async () => {
    if (!purchaseTarget) return
    const n = parseInt(purchaseCount, 10)
    if (!purchaseCount.trim() || Number.isNaN(n) || n <= 0) {
      toast.error('请填写提货数量（≥ 1）')
      return
    }
    setPurchasingId(purchaseTarget.id)
    try {
      const zone = purchaseTarget.platform === 'kiro_ceo' ? purchaseZone : undefined
      const res = await purchaseUpstream(purchaseTarget.id, n, zone)
      toast.success(`提号完成：出 Key ${res.purchased} 个，入库 ${res.imported} 个`)
      setPurchaseTarget(null)
    } catch (e) {
      toast.error('提号失败: ' + extractErrorMessage(e))
    } finally {
      setPurchasingId(null)
    }
  }

  const selectedZoneStock =
    purchaseTarget?.platform === 'kiro_ceo'
      ? profiles[purchaseTarget.id]?.zones?.find((zone) => zone.zone === purchaseZone)
      : undefined
  const purchaseMax = purchaseTarget
    ? selectedZoneStock?.max ?? profiles[purchaseTarget.id]?.max
    : undefined

  return (
    <div className="space-y-5">
      {/* 标题 */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight leading-tight sm:text-[28px] flex items-center gap-2">
            <PackagePlus className="h-6 w-6" />
            补货上游
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
            刷新
          </Button>
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-3.5 w-3.5" />
            添加上游
          </Button>
        </div>
      </div>

      {/* 取货数据统计 */}
      <PickupStatsPanel stats={stats} />

      {/* 列表 */}
      {isLoading ? (
        <Card><CardContent className="py-10 text-sm text-center text-muted-foreground">加载中…</CardContent></Card>
      ) : list.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-sm text-center text-muted-foreground space-y-2">
            <PackagePlus className="h-8 w-8 mx-auto opacity-40" />
            <p>暂无上游。点右上角「添加上游」开始配置。</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {list.map((u) => (
            <UpstreamCard
              key={u.id}
              upstream={u}
              profile={profiles[u.id]}
              loading={loadingId === u.id}
              purchasing={purchasingId === u.id}
              resetting={resettingId === u.id}
              onQuery={() => handleQuery(u)}
              onPurchase={() => openPurchase(u)}
              onEdit={() => openEdit(u)}
              onDelete={() => handleDelete(u)}
              onResetPickupTotal={() => handleResetPickupTotal(u)}
            />
          ))}
        </div>
      )}

      {/* 事件日志 */}
      <EventLog events={events} />

      <UpstreamEditDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        edit={edit}
        onChange={setEdit}
        onSave={handleSave}
        saving={createUpstream.isPending || updateUpstream.isPending}
        groupOptions={groupOptions}
      />

      {/* 手动提号数量弹窗（必须填数量） */}
      <Dialog open={!!purchaseTarget} onOpenChange={(o) => !o && setPurchaseTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>提号入库 · {purchaseTarget?.name}</DialogTitle>
            <DialogDescription>
              手动提号必须指定数量。将提取并作为 api_key 凭据入库（代理池轮询分配），产生真实消费。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {purchaseTarget?.platform === 'kiro_ceo' && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">库存区域</label>
                <div className="grid grid-cols-2 rounded-md border p-1" role="radiogroup" aria-label="库存区域">
                  {(['us', 'eu'] as const).map((zone) => (
                    <Button
                      key={zone}
                      type="button"
                      size="sm"
                      variant={purchaseZone === zone ? 'default' : 'ghost'}
                      role="radio"
                      aria-checked={purchaseZone === zone}
                      onClick={() => setPurchaseZone(zone)}
                      disabled={!!purchasingId}
                      className="h-8"
                    >
                      {zone === 'us' ? 'US 美国区' : 'EU 欧洲区'}
                      {profiles[purchaseTarget.id]?.zones && (
                        <span className="ml-1 text-xs opacity-75">
                          {profiles[purchaseTarget.id]?.zones?.find((item) => item.zone === zone)?.max ?? 0}
                        </span>
                      )}
                    </Button>
                  ))}
                </div>
                {purchaseZone === 'eu' && (
                  <p className="text-xs text-muted-foreground">
                    EU Key 将使用 Auth Region eu、API Region eu-central-1。
                  </p>
                )}
              </div>
            )}
            <div className="space-y-1.5">
            <label className="text-sm font-medium">提货数量 <span className="text-red-500">*</span></label>
            <Input
              type="number"
              min={1}
              max={purchaseMax}
              placeholder={
                purchaseMax
                  ? `1 ~ ${purchaseMax}`
                  : '请输入要提取的数量'
              }
              value={purchaseCount}
              onChange={(e) => setPurchaseCount(e.target.value)}
              disabled={!!purchasingId}
              autoFocus
              autoComplete="off"
            />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPurchaseTarget(null)} disabled={!!purchasingId}>
              取消
            </Button>
            <Button onClick={handlePurchase} disabled={!!purchasingId || !purchaseCount.trim()}>
              {purchasingId ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <KeyRound className="h-4 w-4 mr-1" />}
              提号入库
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
// ── 取货数据统计面板（累计 / 今日 / 本周）───────────────────────────────────

function PickupStatsPanel({ stats }: { stats?: PickupStats }) {
  const items: { label: string; keys: number; orders: number; accent?: string }[] = [
    { label: '今日取货', keys: stats?.todayKeys ?? 0, orders: stats?.todayOrders ?? 0, accent: 'text-emerald-600 dark:text-emerald-400' },
    { label: '本周取货', keys: stats?.weekKeys ?? 0, orders: stats?.weekOrders ?? 0, accent: 'text-blue-600 dark:text-blue-400' },
    { label: '累计取货', keys: stats?.totalKeys ?? 0, orders: stats?.totalOrders ?? 0 },
  ]
  return (
    <div className="grid grid-cols-3 gap-2 sm:gap-4">
      {items.map((it) => (
        <Card key={it.label}>
          <CardContent className="p-3 sm:p-5">
            <div className="text-[11px] font-medium text-muted-foreground sm:text-[13px]">{it.label}</div>
            <div className={`mt-1.5 text-2xl font-semibold tracking-tight tabular-nums sm:mt-2 sm:text-3xl ${it.accent ?? ''}`}>
              {it.keys}
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">{it.orders} 单</div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

// ── 上游卡片 ─────────────────────────────────────────────────────────────────

function UpstreamCard({
  upstream,
  profile,
  loading,
  purchasing,
  resetting,
  onQuery,
  onPurchase,
  onEdit,
  onDelete,
  onResetPickupTotal,
}: {
  upstream: UpstreamConfig
  profile?: UpstreamQueryResult
  loading: boolean
  purchasing: boolean
  resetting: boolean
  onQuery: () => void
  onPurchase: () => void
  onEdit: () => void
  onDelete: () => void
  onResetPickupTotal: () => void
}) {
  const [registering, setRegistering] = useState(false)
  const [testing, setTesting] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)

  const copyWebhook = async () => {
    if (!upstream.webhookReceiverUrl) return
    try {
      await navigator.clipboard.writeText(upstream.webhookReceiverUrl)
      toast.success('已复制 Webhook 接收地址')
    } catch {
      toast.error('复制失败')
    }
  }

  const handleRegister = async () => {
    setRegistering(true)
    try {
      const res = await registerUpstreamWebhook(upstream.id)
      toast.success(res.message)
    } catch (e) {
      toast.error('注册失败: ' + extractErrorMessage(e))
    } finally {
      setRegistering(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    try {
      const res = await testUpstreamWebhook(upstream.id)
      toast.success(res.message)
    } catch (e) {
      toast.error('测试失败: ' + extractErrorMessage(e))
    } finally {
      setTesting(false)
    }
  }

  return (
    <Card className="min-w-0">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-medium truncate">{upstream.name}</span>
              <Badge variant="outline" className="text-xs shrink-0">
                {PLATFORM_LABEL[upstream.platform] ?? upstream.platform}
              </Badge>
              {!upstream.enabled && <Badge variant="outline" className="text-xs text-muted-foreground">已禁用</Badge>}
              {isDirectKeyWebhook(upstream.platform) && (
                <Badge variant="secondary" className="text-xs gap-1 shrink-0">
                  <Webhook className="h-3 w-3" />
                  自动入库
                </Badge>
              )}
              {upstream.autoPurchaseEnabled && (
                <Badge variant="secondary" className="text-xs gap-1 shrink-0">
                  <Zap className="h-3 w-3" />
                  {upstream.schedule?.enabled && upstream.schedule.peakWindows.length > 0
                    ? `分时 高峰${fmtCount(upstream.schedule.peakCount)}/低谷${fmtCount(upstream.schedule.offpeakCount)}`
                    : `自动提号 ${fmtCount(upstream.autoPurchaseCount)}`}
                </Badge>
              )}
            </div>
            {isDirectKeyWebhook(upstream.platform) ? (
              <div className="text-xs text-muted-foreground">
                Secret: {upstream.webhookSecretSet ? '已配置' : '未配置'}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground font-mono truncate">Key: {upstream.maskedApiKey}</div>
            )}
            {upstream.note && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{upstream.note}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onEdit} title="编辑">
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-destructive hover:text-destructive"
              onClick={onDelete}
              title="删除"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        <div className="flex h-8 items-center gap-2 rounded-md bg-secondary/40 px-2.5 text-xs">
          <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">累计取货</span>
          <span className="font-semibold tabular-nums">{upstream.pickupTotal}</span>
          <span className="text-muted-foreground">个</span>
          <Button
            size="icon"
            variant="ghost"
            className="ml-auto h-6 w-6"
            onClick={onResetPickupTotal}
            disabled={resetting}
            title="重置累计取货（保留历史记录）"
          >
            <RotateCcw className={`h-3.5 w-3.5 ${resetting ? 'animate-spin' : ''}`} />
          </Button>
        </div>

        {/* 余额 / 库存 */}
        {!isDirectKeyWebhook(upstream.platform) && profile && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {profile.remaining != null && (
              <Badge variant="secondary" className="gap-1"><Wallet className="h-3 w-3" />{balanceLabel(upstream.platform)} {profile.remaining}</Badge>
            )}
            {upstream.platform === 'kiro_ceo' && profile.zones?.map((zone) => (
              <Badge key={zone.zone} variant="secondary" className="gap-1">
                <KeyRound className="h-3 w-3" />
                {zone.zone.toUpperCase()} {zone.max} 个
                {zone.keyPrice != null ? ` · ${zone.keyPrice} 积分` : ''}
              </Badge>
            ))}
            {!(upstream.platform === 'kiro_ceo' && profile.zones?.length) && profile.max != null && (
              <Badge variant="secondary" className="gap-1"><KeyRound className="h-3 w-3" />可提取 {profile.max} 个</Badge>
            )}
            {!(upstream.platform === 'kiro_ceo' && profile.zones?.length) && profile.keyPrice != null && (
              <Badge variant="secondary" className="gap-1">
                单价{' '}
                {profile.priceMax != null && profile.priceMax !== profile.keyPrice
                  ? `${profile.keyPrice}~${profile.priceMax}`
                  : profile.keyPrice}
              </Badge>
            )}
          </div>
        )}

        {/* Webhook 接收地址：全打码短展示，完整地址仅通过复制获取 */}
        {!supportsWebhook(upstream.platform) ? null : upstream.webhookReceiverUrl ? (
          <div className="flex items-center gap-1.5 rounded-md bg-secondary/40 px-2 py-1.5">
            <Webhook className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="flex-1 min-w-0 truncate text-[11px] text-muted-foreground">
              {canRegisterWebhook(upstream.platform)
                ? '回调地址已配置 ·····'
                : isDirectKeyWebhook(upstream.platform)
                  ? '接收地址已生成 ····· 请提供给推送方'
                  : '回调地址已生成 ····· 需手动填到平台网页'}
            </span>
            <Button size="icon" variant="ghost" className="h-6 w-6" onClick={copyWebhook} title="复制完整接收地址">
              <Copy className="h-3 w-3" />
            </Button>
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">未配置「本服务对外地址」，无法生成 Webhook 接收地址</p>
        )}

        {/* 操作 */}
        <div className="flex flex-wrap items-center gap-1.5">
          {!isDirectKeyWebhook(upstream.platform) && (
            <>
              <Button size="sm" variant="outline" className="h-8 text-xs" onClick={onQuery} disabled={loading}>
                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wallet className="h-3.5 w-3.5" />}
                {upstream.platform === 'legacy' ? '查询余额' : '查询库存'}
              </Button>
              <Button size="sm" variant="outline" className="h-8 text-xs" onClick={onPurchase} disabled={purchasing}>
                {purchasing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
                提号入库
              </Button>
            </>
          )}
          {canRegisterWebhook(upstream.platform) && (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                onClick={handleRegister}
                disabled={registering || !upstream.webhookReceiverUrl}
                title={upstream.webhookReceiverUrl ? '把接收地址注册到上游' : '请先配置本服务对外地址'}
              >
                {registering ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Webhook className="h-3.5 w-3.5" />}
                注册 Webhook
              </Button>
              <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={handleTest} disabled={testing}>
                {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                测试推送
              </Button>
              <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setDetailsOpen(true)}>
                <Info className="h-3.5 w-3.5" />
                详情
              </Button>
            </>
          )}
        </div>
      </CardContent>
      <UpstreamDetailsDialog upstream={upstream} open={detailsOpen} onOpenChange={setDetailsOpen} />
    </Card>
  )
}

// ── 上游详情弹窗：有效期起点 / 最近订单 / 系统库存 ───────────────────────────

function UpstreamDetailsDialog({
  upstream,
  open,
  onOpenChange,
}: {
  upstream: UpstreamConfig
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const [loading, setLoading] = useState(false)
  const [createdAt, setCreatedAt] = useState<KeysCreatedAt | null>(null)
  const [orders, setOrders] = useState<UpstreamOrder[]>([])
  const [status, setStatus] = useState<Record<string, unknown> | null>(null)
  const [err, setErr] = useState<string | null>(null)

  // 打开时并发拉取三类信息
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setErr(null)
    Promise.allSettled([
      queryUpstreamCreatedAt(upstream.id),
      queryUpstreamOrders(upstream.id),
      queryUpstreamStatus(upstream.id),
    ]).then(([ca, od, st]) => {
      if (cancelled) return
      if (ca.status === 'fulfilled') setCreatedAt(ca.value)
      if (od.status === 'fulfilled') setOrders(od.value)
      if (st.status === 'fulfilled') setStatus(st.value)
      if (ca.status === 'rejected' && od.status === 'rejected' && st.status === 'rejected') {
        setErr(extractErrorMessage(ca.reason))
      }
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [open, upstream.id])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>上游详情 · {upstream.name}</DialogTitle>
          <DialogDescription>账号有效期起点、最近提取订单与系统库存（实时查询上游）</DialogDescription>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto space-y-4 py-2 pr-1">
          {loading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />查询中…
            </div>
          ) : err ? (
            <div className="py-6 text-center text-sm text-destructive">{err}</div>
          ) : (
            <>
              {/* 有效期起点 */}
              <div className="space-y-1.5">
                <h3 className="text-sm font-medium">账号有效期起点</h3>
                <div className="rounded-lg border p-3 text-sm">
                  {createdAt?.createdAt ? (
                    <div className="flex items-center justify-between">
                      <span className="font-mono">{createdAt.createdAt}</span>
                      <Badge variant="secondary" className="text-xs">共 {createdAt.keyCount} 条 Key 记录</Badge>
                    </div>
                  ) : (
                    <span className="text-muted-foreground">该账号暂无 Key 记录</span>
                  )}
                </div>
              </div>

              {/* 系统库存 */}
              <div className="space-y-1.5">
                <h3 className="text-sm font-medium">系统状态 / 库存</h3>
                {status ? (
                  <div className="flex flex-wrap gap-2">
                    {statusBadges(status)}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">未获取到系统状态</p>
                )}
              </div>

              {/* 最近订单 */}
              <div className="space-y-1.5">
                <h3 className="text-sm font-medium">最近提取订单（{orders.length}）</h3>
                {orders.length === 0 ? (
                  <p className="text-sm text-muted-foreground">暂无订单</p>
                ) : (
                  <div className="border rounded-md divide-y max-h-[220px] overflow-y-auto">
                    {orders.map((o, i) => (
                      <div key={o.clientOrderId ?? i} className="flex items-center justify-between gap-2 p-2 text-xs">
                        <span className="font-mono truncate" title={o.clientOrderId}>
                          {o.clientOrderId ? `${o.clientOrderId.slice(0, 8)}…` : `#${i + 1}`}
                        </span>
                        <span className="text-muted-foreground">
                          请求 {o.requested ?? '-'} / 交付 {o.purchased ?? '-'}
                        </span>
                        <span className="text-muted-foreground shrink-0">{o.createdAt ?? ''}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// 把 /api/status 里的常见数值字段渲染成 Badge（宽松，未知结构也不报错）
function statusBadges(status: Record<string, unknown>) {
  const labels: Record<string, string> = {
    keys_active: '可用',
    keys_dead: '失效',
    keys_stock: '库存',
    generating: '生成中',
  }
  const items = Object.entries(labels)
    .filter(([k]) => k in status)
    .map(([k, label]) => {
      const v = status[k]
      const text = typeof v === 'boolean' ? (v ? '是' : '否') : String(v)
      return (
        <Badge key={k} variant="secondary" className="text-xs">
          {label} {text}
        </Badge>
      )
    })
  return items.length > 0 ? (
    items
  ) : (
    <span className="text-sm text-muted-foreground">（无可识别的库存字段）</span>
  )
}

// ── 事件日志 ─────────────────────────────────────────────────────────────────

function eventIcon(e: UpstreamEvent) {
  if (!e.ok) return <XCircle className="h-4 w-4 text-red-500 shrink-0" />
  switch (e.kind) {
    case 'new_keys_available':
      return <Zap className="h-4 w-4 text-sky-500 shrink-0" />
    case 'all_keys_dead':
      return <AlertCircle className="h-4 w-4 text-yellow-500 shrink-0" />
    case 'auto_purchase':
    case 'manual_purchase':
    case 'key_pulled':
      return <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
    case 'pickup_total_reset':
      return <RotateCcw className="h-4 w-4 text-amber-500 shrink-0" />
    default:
      return <Info className="h-4 w-4 text-muted-foreground shrink-0" />
  }
}

function EventLog({ events }: { events: UpstreamEvent[] }) {
  return (
    <Card>
      <CardContent className="p-4 space-y-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">事件日志</h2>
          <Badge variant="secondary" className="text-xs">{events.length}</Badge>
        </div>
        {events.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">暂无事件</p>
        ) : (
          <div className="border rounded-md divide-y max-h-[360px] overflow-y-auto">
            {events.map((e) => (
              <div key={e.id} className="flex items-start gap-2 p-2.5">
                {eventIcon(e)}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-medium">{e.upstreamName}</span>
                    <span className="text-[11px] text-muted-foreground">{new Date(e.createdAt).toLocaleString()}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">{e.message}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
// ── 高峰时段规则编辑器（多条：星期几 + 起止整点）────────────────────────────

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => h)

function PeakWindowEditor({
  windows,
  onChange,
  disabled,
}: {
  windows: PeakWindow[]
  onChange: (w: PeakWindow[]) => void
  disabled?: boolean
}) {
  const addWindow = () =>
    onChange([...windows, { weekdays: [1, 2, 3, 4, 5], startHour: 9, endHour: 18 }])

  const removeWindow = (i: number) => onChange(windows.filter((_, idx) => idx !== i))

  const patch = (i: number, p: Partial<PeakWindow>) =>
    onChange(windows.map((w, idx) => (idx === i ? { ...w, ...p } : w)))

  const toggleDay = (i: number, day: number) => {
    const w = windows[i]
    const has = w.weekdays.includes(day)
    const next = has ? w.weekdays.filter((d) => d !== day) : [...w.weekdays, day].sort((a, b) => a - b)
    patch(i, { weekdays: next })
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-muted-foreground">高峰时段规则（命中任一即为高峰）</label>
        <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={addWindow} disabled={disabled}>
          <Plus className="h-3 w-3" />
          添加时段
        </Button>
      </div>

      {windows.length === 0 ? (
        <p className="text-xs text-muted-foreground rounded-md border border-dashed p-2 text-center">
          未添加高峰时段。点「添加时段」新增（可加多条，不同星期几 / 不同时间段）。
        </p>
      ) : (
        <div className="space-y-2">
          {windows.map((w, i) => (
            <div key={i} className="space-y-1.5 rounded-md border p-2">
              {/* 星期几多选 */}
              <div className="flex flex-wrap items-center gap-1">
                {WEEKDAY_LABELS.map((label, day) => {
                  const active = w.weekdays.length === 0 || w.weekdays.includes(day)
                  const allDays = w.weekdays.length === 0
                  return (
                    <button
                      key={day}
                      type="button"
                      disabled={disabled}
                      onClick={() => toggleDay(i, day)}
                      title={allDays ? '当前为每天，点击将改为仅选中此天' : undefined}
                      className={`h-6 w-6 rounded-full text-xs transition-colors ${active
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-secondary text-muted-foreground hover:bg-accent'
                        }`}
                    >
                      {label}
                    </button>
                  )
                })}
                <span className="ml-1 text-[11px] text-muted-foreground">
                  {w.weekdays.length === 0 ? '每天' : ''}
                </span>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="ml-auto h-6 w-6 text-destructive hover:text-destructive"
                  onClick={() => removeWindow(i)}
                  disabled={disabled}
                  title="删除此时段"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
              {/* 起止整点 */}
              <div className="flex items-center gap-2">
                <HourSelect
                  value={w.startHour}
                  onChange={(h) => patch(i, { startHour: h })}
                  disabled={disabled}
                />
                <span className="text-muted-foreground text-sm shrink-0">→</span>
                <HourSelect
                  value={w.endHour}
                  onChange={(h) => patch(i, { endHour: h })}
                  disabled={disabled}
                />
                <span className="text-[11px] text-muted-foreground shrink-0">
                  {w.startHour === w.endHour
                    ? '（起止相同=空窗）'
                    : w.startHour > w.endHour
                      ? '（跨天）'
                      : ''}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function HourSelect({
  value,
  onChange,
  disabled,
}: {
  value: number
  onChange: (h: number) => void
  disabled?: boolean
}) {
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(parseInt(v, 10))} disabled={disabled}>
      <SelectTrigger className="h-8 flex-1 rounded-lg px-2.5 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-[240px]">
        {HOUR_OPTIONS.map((h) => (
          <SelectItem key={h} value={String(h)}>
            {String(h).padStart(2, '0')}:00
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// ── 上游编辑 / 新建弹窗 ──────────────────────────────────────────────────────

function UpstreamEditDialog({
  open,
  onOpenChange,
  edit,
  onChange,
  onSave,
  saving,
  groupOptions,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  edit: EditState
  onChange: (e: EditState) => void
  onSave: () => void
  saving: boolean
  groupOptions: string[]
}) {
  const set = (patch: Partial<EditState>) => onChange({ ...edit, ...patch })
  const setPlatform = (platform: UpstreamPlatform) => {
    // baseUrl：只在当前值是「某个平台的默认地址」时才替换，避免覆盖用户手填的地址。
    const defaults = Object.values(PLATFORM_DEFAULT_BASE_URL).filter(Boolean)
    const baseUrl = defaults.includes(edit.baseUrl)
      ? PLATFORM_DEFAULT_BASE_URL[platform]
      : edit.baseUrl || PLATFORM_DEFAULT_BASE_URL[platform]
    if (isDirectKeyWebhook(platform)) {
      set({
        platform,
        baseUrl: '',
        autoPurchaseEnabled: false,
        scheduleEnabled: false,
      })
      return
    }
    // 不收 webhook 的平台清掉回调与自动提号，避免留下无效配置
    if (!supportsWebhook(platform)) {
      set({
        platform,
        baseUrl,
        receiverBaseUrl: '',
        autoPurchaseEnabled: false,
        scheduleEnabled: false,
      })
    } else {
      set({ platform, baseUrl })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[88vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{edit.id ? '编辑上游' : '添加上游'}</DialogTitle>
          <DialogDescription>配置上游提货渠道。API Key 存于服务端，不会明文回显。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 overflow-y-auto py-2 pr-1">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">上游名称 <span className="text-red-500">*</span></label>
            <Input
              placeholder="例: 转售商A、采购平台X"
              value={edit.name}
              onChange={(e) => set({ name: e.target.value })}
              disabled={saving}
              autoFocus
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">平台类型</label>
            <Select
              value={edit.platform}
              onValueChange={(value) => setPlatform(value as UpstreamPlatform)}
              disabled={saving}
            >
              <SelectTrigger className="h-10 rounded-xl px-3.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="legacy">千羽架构</SelectItem>
                <SelectItem value="kiro_app">KiroApp</SelectItem>
                <SelectItem value="kiro_market">Kiro Market</SelectItem>
                <SelectItem value="kiro_ceo">Kiro CEO</SelectItem>
                <SelectItem value="kiro_key_webhook">Kiro API Key 通知</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {!isDirectKeyWebhook(edit.platform) && (
            <>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">API 基础地址</label>
                <Input
                  placeholder={PLATFORM_DEFAULT_BASE_URL[edit.platform] || 'https://api.example.com'}
                  value={edit.baseUrl}
                  onChange={(e) => set({ baseUrl: e.target.value })}
                  disabled={saving}
                  className="font-mono text-sm"
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">
                  上游 API Key {edit.id ? <span className="text-xs text-muted-foreground">（留空不修改）</span> : <span className="text-red-500">*</span>}
                </label>
                <Input
                  type="password"
                  placeholder={
                    edit.platform === 'kiro_market'
                      ? 'km_xxxxxxxx（设置 → API 令牌 生成）'
                      : edit.platform === 'kiro_ceo'
                        ? 'Kiro CEO API Key'
                        : edit.platform === 'kiro_app'
                          ? 'KiroApp Open API Key'
                          : 'usr-xxxxxxxx'
                  }
                  value={edit.apiKey}
                  onChange={(e) => set({ apiKey: e.target.value })}
                  disabled={saving}
                  className="font-mono text-sm"
                  autoComplete="new-password"
                />
              </div>
            </>
          )}
          {isDirectKeyWebhook(edit.platform) && (
            <>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">HTTPS 接收地址 <span className="text-red-500">*</span></label>
                <Input
                  placeholder="https://your-host:8990"
                  value={edit.receiverBaseUrl}
                  onChange={(e) => set({ receiverBaseUrl: e.target.value })}
                  disabled={saving}
                  className="font-mono text-sm"
                  autoComplete="off"
                />
                <p className="text-xs text-muted-foreground">
                  保存后复制生成的完整接收地址并提供给推送方。
                </p>
              </div>
              <div className="space-y-2 rounded-xl border p-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium">校验 Webhook Secret</div>
                    <p className="text-xs text-muted-foreground">校验请求头 X-Webhook-Secret</p>
                  </div>
                  <Switch
                    checked={edit.webhookSecretEnabled}
                    onCheckedChange={(enabled) => set({ webhookSecretEnabled: enabled })}
                    disabled={saving}
                  />
                </div>
                {edit.webhookSecretEnabled && (
                  <Input
                    type="password"
                    placeholder={edit.webhookSecretSet ? '已配置；留空不修改' : '输入约定的 Secret'}
                    value={edit.webhookSecret}
                    onChange={(e) => set({ webhookSecret: e.target.value })}
                    disabled={saving}
                    className="font-mono text-sm"
                    autoComplete="new-password"
                  />
                )}
              </div>
            </>
          )}
          {!isDirectKeyWebhook(edit.platform) && supportsWebhook(edit.platform) && (
            <>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">本服务对外地址</label>
                <Input
                  placeholder="https://your-host:8990（用于生成 webhook 接收地址）"
                  value={edit.receiverBaseUrl}
                  onChange={(e) => set({ receiverBaseUrl: e.target.value })}
                  disabled={saving}
                  className="font-mono text-sm"
                  autoComplete="off"
                />
                <p className="text-xs text-muted-foreground">
                  {canRegisterWebhook(edit.platform)
                    ? '上游回调本服务用。留空则不生成接收地址、无法注册 Webhook。'
                    : 'Kiro Market 没有注册接口：填好后把下方生成的接收地址复制到平台网页「设置 → Webhook 配置」里，可在那里发 test 事件验证连通。'}
                </p>
              </div>

              {/* 自动提号配置 */}
              <div className="space-y-2 rounded-xl border p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">自动提号（低消）</div>
                    <p className="text-xs text-muted-foreground leading-snug">
                      收到 new_keys_available 时按「最低提货量」自动提取并入库（代理池轮询分配）；
                      收到 all_keys_dead 仅在事件日志记录，不提货
                    </p>
                  </div>
                  <Switch
                    checked={edit.autoPurchaseEnabled}
                    onCheckedChange={(v) => set({ autoPurchaseEnabled: v })}
                    disabled={saving}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">默认提货量（低消）</label>
                  <Input
                    type="number"
                    min={0}
                    placeholder="0 = 按可提取上限提满"
                    value={edit.autoPurchaseCount}
                    onChange={(e) => set({ autoPurchaseCount: e.target.value })}
                    disabled={saving || !edit.autoPurchaseEnabled}
                    autoComplete="off"
                  />
                  <p className="text-xs text-muted-foreground">
                    未开启「分时段」时用此数量；填 0 表示按上游本轮可提取上限（stock.max）尽量提满。
                  </p>
                </div>

                {/* 分时段提货量：多条高峰规则 + 高峰/低谷两档 */}
                <div className="space-y-2 rounded-lg border p-2.5 bg-secondary/20">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-medium">按时间设置提货量（高峰 / 低谷）</div>
                      <p className="text-xs text-muted-foreground leading-snug">
                        自定义"哪几天 + 几点到几点"为高峰（北京时间）；命中任一高峰规则用高峰量，其余用低谷量
                      </p>
                    </div>
                    <Switch
                      checked={edit.scheduleEnabled}
                      onCheckedChange={(v) => set({ scheduleEnabled: v })}
                      disabled={saving || !edit.autoPurchaseEnabled}
                    />
                  </div>
                  {edit.scheduleEnabled && (
                    <div className="space-y-3">
                      <PeakWindowEditor
                        windows={edit.peakWindows}
                        onChange={(w) => set({ peakWindows: w })}
                        disabled={saving}
                      />
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">高峰提货量</label>
                          <Input
                            type="number" min={0}
                            placeholder="0 = 提满"
                            value={edit.peakCount}
                            onChange={(e) => set({ peakCount: e.target.value })}
                            disabled={saving} autoComplete="off" className="h-9"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">低谷提货量</label>
                          <Input
                            type="number" min={0}
                            placeholder="0 = 提满"
                            value={edit.offpeakCount}
                            onChange={(e) => set({ offpeakCount: e.target.value })}
                            disabled={saving} autoComplete="off" className="h-9"
                          />
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        各档填 0 表示该时段按上游可提取上限提满。时间为<b>北京时间(UTC+8)</b>整点，右开区间；起 &gt; 止表示跨天（如 22→6）。
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          <div className="space-y-1.5">
            <label className="text-sm font-medium">默认端点</label>
            <Select
              value={edit.endpoint === '' ? '__default__' : edit.endpoint}
              onValueChange={(v) => set({ endpoint: v === '__default__' ? '' : v })}
              disabled={saving}
            >
              <SelectTrigger className="h-10 rounded-xl px-3.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">使用全局默认端点</SelectItem>
                <SelectItem value="cli">cli</SelectItem>
                <SelectItem value="ide">ide</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              提号入库的 ksk 凭据使用的端点。ksk key 通常走 <b>cli</b>；留空则用全局 defaultEndpoint。
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">入库分组</label>
            <GroupMultiSelect
              value={edit.groups}
              options={groupOptions}
              onChange={(g) => set({ groups: g })}
              disabled={saving}
            />
            <p className="text-xs text-muted-foreground">提号入库的凭据会打上这些分组。</p>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">备注</label>
            <Input
              placeholder="渠道说明、结算方式等（可选）"
              value={edit.note}
              onChange={(e) => set({ note: e.target.value })}
              disabled={saving}
              autoComplete="off"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>取消</Button>
          <Button onClick={onSave} disabled={saving || !edit.name.trim()}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
