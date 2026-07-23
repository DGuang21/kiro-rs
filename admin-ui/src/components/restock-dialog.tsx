import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Wallet,
  KeyRound,
  Shuffle,
  Eraser,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertCircle,
  PackageCheck,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'
import { GroupMultiSelect } from '@/components/group-select'
import { useGroupOptions } from '@/hooks/use-groups'
import { useUpstreams } from '@/hooks/use-upstream'
import {
  queryUpstreamBalance,
  extractUpstreamKeys,
  type UpstreamBalance,
} from '@/api/upstream'
import {
  batchImportCredentials,
  getProxyPool,
  type BatchImportItemEvent,
  type BatchImportSummary,
} from '@/api/credentials'
import type { AddCredentialRequest } from '@/types/api'
import { extractErrorMessage, maskProxyUrl } from '@/lib/utils'

interface RestockDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

// 单个 KEY 入库结果
interface RowResult {
  index: number
  status: 'pending' | 'verifying' | 'verified' | 'imported' | 'duplicate' | 'failed'
  error?: string
  usage?: string
  email?: string
  proxyUrl?: string
}
/**
 * 一键补货弹窗。
 *
 * 流程：选上游 → 查询余额（显示余额/剩余数量/备注）→ 选数量 → Mock 提货拿到 KEY
 * → 逐 KEY 指定代理（可随机分配）→ 批量入库（复用 batchImportCredentials）。
 *
 * ⚠️ 提货为 Mock；拿到真实上游 API 后替换 api/upstream.ts 即可，本弹窗无需改动。
 */
export function RestockDialog({ open, onOpenChange }: RestockDialogProps) {
  const [upstreamId, setUpstreamId] = useState('')
  const [balance, setBalance] = useState<UpstreamBalance | null>(null)
  const [balanceLoading, setBalanceLoading] = useState(false)
  const [count, setCount] = useState('5')

  // 提货拿到的 KEY 及逐行代理分配（行内容为 key）
  const [keys, setKeys] = useState<string[]>([])
  const [extracting, setExtracting] = useState(false)
  const [rowProxy, setRowProxy] = useState<Record<string, string>>({})

  // 共享入库字段
  const [groups, setGroups] = useState<string[]>([])
  const [sourceChannel, setSourceChannel] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [verify, setVerify] = useState(false)

  // 入库进度
  const [importing, setImporting] = useState(false)
  const [progressTotal, setProgressTotal] = useState(0)
  const [results, setResults] = useState<RowResult[]>([])
  const abortRef = useRef<AbortController | null>(null)

  const { data: upstreams } = useUpstreams()
  const groupOptions = useGroupOptions()
  const queryClient = useQueryClient()

  const { data: proxyPool } = useQuery({
    queryKey: ['proxy-pool'],
    queryFn: getProxyPool,
    enabled: open,
  })
  const enabledProxies = useMemo(
    () => proxyPool?.proxies.filter((p) => p.enabled) ?? [],
    [proxyPool],
  )

  const list = upstreams ?? []
  const currentUpstream = list.find((u) => u.id === upstreamId) ?? null

  const reset = () => {
    setUpstreamId('')
    setBalance(null)
    setCount('5')
    setKeys([])
    setRowProxy({})
    setGroups([])
    setSourceChannel('')
    setEndpoint('')
    setVerify(false)
    setProgressTotal(0)
    setResults([])
  }

  // 打开时清空；关闭时若在入库则中断
  useEffect(() => {
    if (open) reset()
  }, [open])

  // 切换上游：清空余额与已提取 KEY，来源渠道默认填上游名
  useEffect(() => {
    setBalance(null)
    setKeys([])
    setRowProxy({})
    setResults([])
    setSourceChannel(currentUpstream?.name ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upstreamId])

  const handleQueryBalance = async () => {
    if (!upstreamId) {
      toast.error('请先选择上游')
      return
    }
    setBalanceLoading(true)
    try {
      const b = await queryUpstreamBalance(upstreamId)
      setBalance(b)
    } catch (e) {
      toast.error('查询失败: ' + extractErrorMessage(e))
    } finally {
      setBalanceLoading(false)
    }
  }

  const handleExtract = async () => {
    if (!upstreamId) {
      toast.error('请先选择上游')
      return
    }
    const n = parseInt(count, 10)
    if (Number.isNaN(n) || n <= 0) {
      toast.error('请输入有效数量')
      return
    }
    setExtracting(true)
    try {
      const res = await extractUpstreamKeys(upstreamId, n)
      setKeys(res.keys)
      setResults([])
      toast.success(`已提货 ${res.keys.length} 个 KEY，消耗 ¥${res.cost}，剩余 ${res.remainingKeys} 个`)
      // 刷新余额展示
      setBalance((prev) => (prev ? { ...prev, remainingKeys: res.remainingKeys, balance: prev.balance - res.cost } : prev))
    } catch (e) {
      toast.error('提货失败: ' + extractErrorMessage(e))
    } finally {
      setExtracting(false)
    }
  }

  // 代理池打乱后 round-robin 分配给每个 KEY
  const assignRandomProxies = () => {
    if (enabledProxies.length === 0) {
      toast.error('代理池没有可用代理')
      return
    }
    if (keys.length === 0) {
      toast.error('请先提货')
      return
    }
    const shuffled = [...enabledProxies].sort(() => Math.random() - 0.5)
    const next: Record<string, string> = {}
    keys.forEach((k, i) => {
      next[k] = shuffled[i % shuffled.length].url
    })
    setRowProxy(next)
    toast.success(`已为 ${keys.length} 个 KEY 随机分配代理`)
  }

  const updateResult = (i: number, patch: Partial<RowResult>) => {
    setResults((prev) => {
      const next = [...prev]
      next[i] = { ...next[i], ...patch }
      return next
    })
  }
  // 批量入库：把提货的 KEY 作为 api_key 凭据导入
  const handleImport = async () => {
    if (keys.length === 0) {
      toast.error('请先提货')
      return
    }
    const reqs: AddCredentialRequest[] = keys.map((k) => ({
      authMethod: 'api_key',
      kiroApiKey: k,
      endpoint: endpoint.trim() || undefined,
      groups,
      sourceChannel: sourceChannel.trim() || undefined,
      proxyUrl: rowProxy[k]?.trim() || undefined,
    }))

    setImporting(true)
    setProgressTotal(reqs.length)
    setResults(
      keys.map((k, i) => ({
        index: i + 1,
        status: 'verifying',
        proxyUrl: rowProxy[k]?.trim() || undefined,
      })),
    )

    try {
      const controller = new AbortController()
      abortRef.current = controller
      await batchImportCredentials(
        { credentials: reqs, concurrency: 8, verify },
        (ev: BatchImportItemEvent) => {
          const i = ev.index
          if (i < 0 || i >= reqs.length) return
          if (ev.status === 'verified') updateResult(i, { status: 'verified', usage: ev.usage, email: ev.email })
          else if (ev.status === 'imported') updateResult(i, { status: 'imported', email: ev.email })
          else if (ev.status === 'duplicate') updateResult(i, { status: 'duplicate', error: ev.error || '该凭据已存在' })
          else updateResult(i, { status: 'failed', error: ev.error })
        },
        (s: BatchImportSummary) => {
          const okTotal = s.imported + s.verified
          if (s.failed === 0 && s.duplicate === 0) {
            toast.success(`补货入库完成：成功 ${okTotal} 个`)
          } else {
            toast.info(`入库完成：成功 ${okTotal} 个，重复 ${s.duplicate} 个，失败 ${s.failed} 个`)
          }
        },
        controller.signal,
      )
      await queryClient.invalidateQueries({ queryKey: ['credentials'] })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        toast.info('已停止入库（已完成的保留）')
        await queryClient.invalidateQueries({ queryKey: ['credentials'] })
      } else {
        toast.error('入库失败: ' + extractErrorMessage(error))
      }
    } finally {
      abortRef.current = null
      setImporting(false)
    }
  }

  const handleClose = (nextOpen: boolean) => {
    if (!nextOpen && importing) {
      abortRef.current?.abort()
    }
    onOpenChange(nextOpen)
  }

  const finalizedCount = results.filter(
    (r) => r.status === 'verified' || r.status === 'imported' || r.status === 'duplicate' || r.status === 'failed',
  ).length
  const hasResults = results.length > 0

  const statusIcon = (status: RowResult['status']) => {
    switch (status) {
      case 'verifying':
        return <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
      case 'verified':
        return <CheckCircle2 className="w-4 h-4 text-green-500" />
      case 'imported':
        return <CheckCircle2 className="w-4 h-4 text-sky-500" />
      case 'duplicate':
        return <AlertCircle className="w-4 h-4 text-yellow-500" />
      case 'failed':
        return <XCircle className="w-4 h-4 text-red-500" />
      default:
        return <div className="w-4 h-4 rounded-full border-2 border-gray-300" />
    }
  }
  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg max-h-[88vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PackageCheck className="h-5 w-5" />
            一键补货
          </DialogTitle>
          <DialogDescription>
            选上游 → 查余额 → 提货 → 为每个 KEY 指定代理 → 批量入库。当前提货为 Mock。
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4 py-2 pr-1">
          {/* 选择上游 */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">选择上游</label>
            {list.length === 0 ? (
              <div className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground">
                暂无上游，请先到「补货上游」Tab 添加。
              </div>
            ) : (
              <Select value={upstreamId} onValueChange={setUpstreamId} disabled={importing}>
                <SelectTrigger className="h-10 rounded-xl px-3.5">
                  <SelectValue placeholder="请选择上游渠道" />
                </SelectTrigger>
                <SelectContent>
                  {list.map((u) => (
                    <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {currentUpstream?.note && (
              <p className="text-xs text-muted-foreground">备注：{currentUpstream.note}</p>
            )}
          </div>

          {/* 余额 / 剩余数量 */}
          {upstreamId && (
            <div className="rounded-xl border p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">上游余额与库存</span>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={handleQueryBalance} disabled={balanceLoading}>
                  {balanceLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wallet className="h-3.5 w-3.5" />}
                  查询余额
                </Button>
              </div>
              {balance ? (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant="secondary" className="gap-1">
                    <Wallet className="h-3 w-3" />余额 {balance.currency}{balance.balance}
                  </Badge>
                  <Badge variant="secondary" className="gap-1">
                    <KeyRound className="h-3 w-3" />剩余 {balance.remainingKeys} 个
                  </Badge>
                  <Badge variant="outline">单价 {balance.currency}{balance.unitPrice}/个</Badge>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">点击「查询余额」获取当前上游余额与可提取数量</p>
              )}
            </div>
          )}

          {/* 数量 + 提货 */}
          {upstreamId && (
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1.5">
                <label className="text-sm font-medium">补货数量</label>
                <Input
                  type="number"
                  min={1}
                  max={balance?.remainingKeys ?? undefined}
                  value={count}
                  onChange={(e) => setCount(e.target.value)}
                  disabled={extracting || importing}
                />
              </div>
              <Button onClick={handleExtract} disabled={extracting || importing}>
                {extracting ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                提货
              </Button>
            </div>
          )}

          {/* 提货结果 + 逐 KEY 代理分配 */}
          {keys.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">已提货 {keys.length} 个 KEY · 指定代理</span>
                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={assignRandomProxies}
                    disabled={importing || enabledProxies.length === 0}
                    title="将代理池中的可用代理随机（不重复）分配给每个 KEY"
                  >
                    <Shuffle className="h-3.5 w-3.5 mr-1" />随机分配
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    onClick={() => setRowProxy({})}
                    disabled={importing || Object.keys(rowProxy).length === 0}
                  >
                    <Eraser className="h-3.5 w-3.5 mr-1" />清除
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">代理池可用 {enabledProxies.length} 个；留空则用全局配置</p>
              <div className="space-y-1.5 max-h-[200px] overflow-y-auto rounded-xl border p-2">
                {keys.map((k, i) => (
                  <div key={k} className="flex items-center gap-2">
                    <span className="w-6 shrink-0 text-center text-xs text-muted-foreground tabular-nums">{i + 1}</span>
                    <span className="w-24 shrink-0 truncate font-mono text-xs" title={k}>
                      {`${k.slice(0, 8)}…${k.slice(-4)}`}
                    </span>
                    <div className="flex-1 min-w-0">
                      <Select
                        value={rowProxy[k] ? rowProxy[k] : '__global__'}
                        onValueChange={(v) => setRowProxy((prev) => ({ ...prev, [k]: v === '__global__' ? '' : v }))}
                        disabled={importing}
                      >
                        <SelectTrigger className="h-8 rounded-lg px-2.5 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__global__">全局代理</SelectItem>
                          <SelectItem value="direct">直连</SelectItem>
                          {enabledProxies.map((p) => (
                            <SelectItem key={p.id} value={p.url}>
                              {p.label ? `${p.label} | ${maskProxyUrl(p.url)}` : maskProxyUrl(p.url)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 共享入库字段 */}
          {keys.length > 0 && (
            <div className="space-y-3 rounded-xl border p-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">账号分组</label>
                <GroupMultiSelect value={groups} options={groupOptions} onChange={setGroups} disabled={importing} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">来源渠道</label>
                  <Input value={sourceChannel} onChange={(e) => setSourceChannel(e.target.value)} disabled={importing} />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">端点</label>
                  <Input placeholder="留空默认" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} disabled={importing} />
                </div>
              </div>
              <div className="flex items-center justify-between gap-2 rounded-lg bg-secondary/40 px-2.5 py-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium">入库后验活</div>
                  <p className="text-xs text-muted-foreground leading-snug">
                    查余额校验、失败自动回滚。Mock KEY 无法验活，接入真实上游后再开启。
                  </p>
                </div>
                <Switch checked={verify} onCheckedChange={setVerify} disabled={importing} />
              </div>
            </div>
          )}

          {/* 入库进度 + 结果 */}
          {(importing || hasResults) && (
            <div className="space-y-2 rounded-xl border p-3">
              <div className="flex justify-between text-sm">
                <span>{importing ? '入库进度' : '入库完成'}</span>
                <span className="tabular-nums">{finalizedCount} / {progressTotal}</span>
              </div>
              <div className="w-full bg-secondary rounded-full h-2">
                <div
                  className="bg-primary h-2 rounded-full transition-all"
                  style={{ width: `${progressTotal > 0 ? (finalizedCount / progressTotal) * 100 : 0}%` }}
                />
              </div>
              <div className="border rounded-md divide-y max-h-[180px] overflow-y-auto">
                {results.map((r) => (
                  <div key={r.index} className="flex items-start gap-2 p-2">
                    {statusIcon(r.status)}
                    <div className="min-w-0 flex-1">
                      <span className="text-xs font-medium">{r.email || `KEY #${r.index}`}</span>
                      {r.proxyUrl && (
                        <div className="text-[11px] text-muted-foreground font-mono truncate">代理: {maskProxyUrl(r.proxyUrl)}</div>
                      )}
                      {r.error && <div className="text-[11px] text-red-600 dark:text-red-400">{r.error}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          {importing ? (
            <Button variant="destructive" onClick={() => abortRef.current?.abort()}>停止入库</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => handleClose(false)}>
                {hasResults ? '关闭' : '取消'}
              </Button>
              {!hasResults && (
                <Button onClick={handleImport} disabled={keys.length === 0}>
                  批量入库（{keys.length}）
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}



