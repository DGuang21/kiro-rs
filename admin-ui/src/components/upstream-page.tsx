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
  Copy,
  Loader2,
  Info,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { useUpstreams, useSaveUpstream, useDeleteUpstream } from '@/hooks/use-upstream'
import {
  queryUpstreamBalance,
  extractUpstreamKeys,
  testUpstreamWebhook,
  type UpstreamConfig,
  type UpstreamBalance,
} from '@/api/upstream'
import { extractErrorMessage } from '@/lib/utils'
type EditTarget = (Partial<UpstreamConfig> & { name: string }) | null

/**
 * 补货上游管理页（Tab）。
 *
 * ⚠️ 当前为 Mock：上游配置存 localStorage，"查询余额 / 提取新 KEY / Webhook"
 * 均返回模拟数据。拿到真实上游 API 后替换 api/upstream.ts 里的 mock 函数即可。
 *
 * 基础能力：
 * - 上游 CRUD（配置 URL + API Key + 各路径）
 * - 查询余额（余额 / 剩余可提取 KEY 数 / 单价）
 * - 提取新 API KEY（此页仅提取展示；批量入库走凭据页「一键补货」）
 * - Webhook 配置与连通性测试
 */
export function UpstreamPage() {
  const { data: upstreams, isLoading, isFetching, refetch } = useUpstreams()
  const saveUpstream = useSaveUpstream()
  const deleteUpstream = useDeleteUpstream()
  const confirm = useConfirm()

  // 编辑 / 新建
  const [editOpen, setEditOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<EditTarget>(null)

  // 余额缓存：id → 结果
  const [balances, setBalances] = useState<Record<string, UpstreamBalance>>({})
  const [balanceLoading, setBalanceLoading] = useState<string | null>(null)

  // 提取 KEY 弹窗
  const [extractTarget, setExtractTarget] = useState<UpstreamConfig | null>(null)

  // Webhook 弹窗
  const [webhookTarget, setWebhookTarget] = useState<UpstreamConfig | null>(null)

  const list = upstreams ?? []

  const openCreate = () => {
    setEditTarget({
      name: '',
      baseUrl: '',
      apiKey: '',
      balancePath: '/v1/balance',
      extractPath: '/v1/keys/issue',
      webhookUrl: '',
      note: '',
    })
    setEditOpen(true)
  }

  const openEdit = (u: UpstreamConfig) => {
    setEditTarget({ ...u })
    setEditOpen(true)
  }

  const handleSave = async () => {
    if (!editTarget) return
    if (!editTarget.name.trim()) {
      toast.error('上游名称不能为空')
      return
    }
    try {
      await saveUpstream.mutateAsync({
        ...editTarget,
        name: editTarget.name.trim(),
      })
      toast.success(editTarget.id ? '上游已更新' : '上游已添加')
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

  const handleQueryBalance = async (u: UpstreamConfig) => {
    setBalanceLoading(u.id)
    try {
      const b = await queryUpstreamBalance(u.id)
      setBalances((prev) => ({ ...prev, [u.id]: b }))
      toast.success(`${u.name}：余额 ${b.currency}${b.balance}，剩余 ${b.remainingKeys} 个`)
    } catch (e) {
      toast.error('查询失败: ' + extractErrorMessage(e))
    } finally {
      setBalanceLoading(null)
    }
  }

  return (
    <div className="space-y-5">
      {/* 标题 */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight leading-tight sm:text-[28px] flex items-center gap-2">
            <PackagePlus className="h-6 w-6" />
            补货上游
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            配置上游提货渠道（URL + API Key），查询余额、提取新 KEY、配置 Webhook
          </p>
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

      {/* Mock 提示条 */}
      <div className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3.5 py-2.5 text-sm text-amber-700 dark:text-amber-400">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          当前为 <b>Mock 演示</b>：查询余额 / 提取 KEY / Webhook 均返回模拟数据。等接入真实上游 API 后即可切换为真实调用。
        </span>
      </div>

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
              balance={balances[u.id]}
              balanceLoading={balanceLoading === u.id}
              onQueryBalance={() => handleQueryBalance(u)}
              onExtract={() => setExtractTarget(u)}
              onWebhook={() => setWebhookTarget(u)}
              onEdit={() => openEdit(u)}
              onDelete={() => handleDelete(u)}
            />
          ))}
        </div>
      )}

      <UpstreamEditDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        target={editTarget}
        onChange={setEditTarget}
        onSave={handleSave}
        saving={saveUpstream.isPending}
      />
      <ExtractKeysDialog upstream={extractTarget} onClose={() => setExtractTarget(null)} />
      <WebhookDialog upstream={webhookTarget} onClose={() => setWebhookTarget(null)} />
    </div>
  )
}
// ── 上游卡片 ─────────────────────────────────────────────────────────────────

function UpstreamCard({
  upstream,
  balance,
  balanceLoading,
  onQueryBalance,
  onExtract,
  onWebhook,
  onEdit,
  onDelete,
}: {
  upstream: UpstreamConfig
  balance?: UpstreamBalance
  balanceLoading: boolean
  onQueryBalance: () => void
  onExtract: () => void
  onWebhook: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-medium truncate">{upstream.name}</div>
            <div className="text-xs text-muted-foreground font-mono truncate">
              {upstream.baseUrl || '未配置 URL'}
            </div>
            {upstream.note && (
              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{upstream.note}</p>
            )}
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

        {/* 余额展示 */}
        {balance && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="secondary" className="gap-1">
              <Wallet className="h-3 w-3" />
              余额 {balance.currency}{balance.balance}
            </Badge>
            <Badge variant="secondary" className="gap-1">
              <KeyRound className="h-3 w-3" />
              剩余 {balance.remainingKeys} 个
            </Badge>
            <Badge variant="outline">单价 {balance.currency}{balance.unitPrice}/个</Badge>
          </div>
        )}

        {/* 操作 */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={onQueryBalance} disabled={balanceLoading}>
            {balanceLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wallet className="h-3.5 w-3.5" />}
            查询余额
          </Button>
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={onExtract}>
            <KeyRound className="h-3.5 w-3.5" />
            提取新 KEY
          </Button>
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={onWebhook}>
            <Webhook className="h-3.5 w-3.5" />
            Webhook
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ── 上游编辑 / 新建弹窗 ──────────────────────────────────────────────────────

function UpstreamEditDialog({
  open,
  onOpenChange,
  target,
  onChange,
  onSave,
  saving,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: EditTarget
  onChange: (t: EditTarget) => void
  onSave: () => void
  saving: boolean
}) {
  if (!target) return null
  const set = (patch: Partial<UpstreamConfig>) => onChange({ ...target, ...patch })

  const field = (
    label: string,
    key: keyof UpstreamConfig,
    placeholder: string,
    opts?: { type?: string; mono?: boolean },
  ) => (
    <div className="space-y-1.5">
      <label className="text-sm font-medium">{label}</label>
      <Input
        type={opts?.type ?? 'text'}
        placeholder={placeholder}
        value={(target[key] as string) ?? ''}
        onChange={(e) => set({ [key]: e.target.value } as Partial<UpstreamConfig>)}
        disabled={saving}
        className={opts?.mono ? 'font-mono text-sm' : undefined}
      />
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{target.id ? '编辑上游' : '添加上游'}</DialogTitle>
          <DialogDescription>配置上游提货渠道。当前为 Mock，URL/Key 仅本地保存。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 overflow-y-auto py-2 pr-1">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">上游名称 <span className="text-red-500">*</span></label>
            <Input
              placeholder="例: 转售商A、采购平台X"
              value={target.name}
              onChange={(e) => set({ name: e.target.value })}
              disabled={saving}
              autoFocus
            />
          </div>
          {field('API 基础地址', 'baseUrl', 'https://api.example.com', { mono: true })}
          {field('上游 API Key', 'apiKey', '上游鉴权 Key', { type: 'password', mono: true })}
          <div className="grid grid-cols-2 gap-2">
            {field('查询余额路径', 'balancePath', '/v1/balance', { mono: true })}
            {field('提取 KEY 路径', 'extractPath', '/v1/keys/issue', { mono: true })}
          </div>
          {field('Webhook 地址', 'webhookUrl', 'https://.../webhook（可选）', { mono: true })}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">备注</label>
            <Input
              placeholder="渠道说明、结算方式等（可选）"
              value={target.note ?? ''}
              onChange={(e) => set({ note: e.target.value })}
              disabled={saving}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>取消</Button>
          <Button onClick={onSave} disabled={saving || !target.name.trim()}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
// ── 提取新 KEY 弹窗（此页仅提取展示，批量入库走凭据页「一键补货」）──────────

function ExtractKeysDialog({ upstream, onClose }: { upstream: UpstreamConfig | null; onClose: () => void }) {
  const [count, setCount] = useState('5')
  const [extracting, setExtracting] = useState(false)
  const [keys, setKeys] = useState<string[]>([])

  const open = !!upstream

  const handleExtract = async () => {
    if (!upstream) return
    const n = parseInt(count, 10)
    if (Number.isNaN(n) || n <= 0) {
      toast.error('请输入有效数量')
      return
    }
    setExtracting(true)
    try {
      const res = await extractUpstreamKeys(upstream.id, n)
      setKeys(res.keys)
      toast.success(`已提取 ${res.keys.length} 个 KEY，消耗 ¥${res.cost}，剩余 ${res.remainingKeys} 个`)
    } catch (e) {
      toast.error('提取失败: ' + extractErrorMessage(e))
    } finally {
      setExtracting(false)
    }
  }

  const handleClose = (o: boolean) => {
    if (!o) {
      setKeys([])
      setCount('5')
      onClose()
    }
  }

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(keys.join('\n'))
      toast.success('已复制全部 KEY')
    } catch {
      toast.error('复制失败')
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>提取新 KEY · {upstream?.name}</DialogTitle>
          <DialogDescription>
            此处仅提取并展示 KEY。要提货后直接批量入库并指定代理，请到「凭据管理 → 一键补货」。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 overflow-y-auto py-2">
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1.5">
              <label className="text-sm font-medium">提取数量</label>
              <Input
                type="number"
                min={1}
                value={count}
                onChange={(e) => setCount(e.target.value)}
                disabled={extracting}
              />
            </div>
            <Button onClick={handleExtract} disabled={extracting}>
              {extracting ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              提取
            </Button>
          </div>

          {keys.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">已提取 {keys.length} 个</span>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={copyAll}>
                  <Copy className="h-3.5 w-3.5 mr-1" />
                  复制全部
                </Button>
              </div>
              <div className="border rounded-md divide-y max-h-[240px] overflow-y-auto">
                {keys.map((k, i) => (
                  <div key={i} className="flex items-center gap-2 p-2 font-mono text-xs">
                    <span className="w-6 shrink-0 text-center text-muted-foreground tabular-nums">{i + 1}</span>
                    <span className="truncate">{k}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleClose(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Webhook 配置 / 测试弹窗 ──────────────────────────────────────────────────

function WebhookDialog({ upstream, onClose }: { upstream: UpstreamConfig | null; onClose: () => void }) {
  const saveUpstream = useSaveUpstream()
  const [url, setUrl] = useState('')
  const [testing, setTesting] = useState(false)

  const open = !!upstream

  // 弹窗目标切换时回填当前上游的 webhookUrl
  useEffect(() => {
    if (upstream) setUrl(upstream.webhookUrl ?? '')
  }, [upstream])

  const handleClose = (o: boolean) => {
    if (!o) {
      setUrl('')
      onClose()
    }
  }

  const handleTest = async () => {
    setTesting(true)
    try {
      const res = await testUpstreamWebhook(url)
      if (res.ok) toast.success(`${res.message}（${res.latencyMs}ms）`)
      else toast.error(res.message)
    } catch (e) {
      toast.error('测试失败: ' + extractErrorMessage(e))
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    if (!upstream) return
    try {
      await saveUpstream.mutateAsync({ id: upstream.id, name: upstream.name, webhookUrl: url.trim() })
      toast.success('Webhook 已保存')
      handleClose(false)
    } catch (e) {
      toast.error(extractErrorMessage(e))
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Webhook · {upstream?.name}</DialogTitle>
          <DialogDescription>
            上游异步通知（如补货完成、库存变动）回调本服务的地址。当前为 Mock 测试。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Webhook 地址</label>
            <Input
              placeholder="https://your-host/api/admin/upstream/webhook"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={saveUpstream.isPending}
              className="font-mono text-sm"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleTest} disabled={testing}>
            {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Webhook className="h-4 w-4" />}
            测试连通
          </Button>
          <Button onClick={handleSave} disabled={saveUpstream.isPending}>
            {saveUpstream.isPending ? '保存中…' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}



