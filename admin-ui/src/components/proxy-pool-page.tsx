import { useState } from 'react'
import { toast } from 'sonner'
import {
  Trash2,
  Plus,
  Upload,
  ToggleLeft,
  ToggleRight,
  Globe,
  Activity,
  Shuffle,
  CheckCircle2,
  XCircle,
  HelpCircle,
  RefreshCw,
  Network,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useConfirm } from '@/components/ui/confirm-dialog'
import {
  getProxyPool,
  addProxy,
  batchAddProxies,
  deleteProxy,
  setProxyEnabled,
  getGlobalProxy,
  setGlobalProxy,
  checkProxy,
  checkAllProxies,
  assignProxiesRoundRobin,
} from '@/api/credentials'
import { extractErrorMessage, maskProxyUrl } from '@/lib/utils'
import type { ProxyPoolEntry } from '@/types/api'

/**
 * 代理 IP 池管理页（独立 Tab）。
 *
 * 与原 ProxyPoolDialog 等价，但作为独立页面：可提前添加 / 批量导入代理、
 * 单个或全部批量验活（健康检查）、设为全局代理、轮询分配给凭据。
 */
export function ProxyPoolPage() {
  const [newUrl, setNewUrl] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [batchText, setBatchText] = useState('')
  const [showBatch, setShowBatch] = useState(false)
  const [batchErrors, setBatchErrors] = useState<string[]>([])
  const queryClient = useQueryClient()
  const confirm = useConfirm()

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['proxy-pool'],
    queryFn: getProxyPool,
  })

  const { data: globalProxyData } = useQuery({
    queryKey: ['global-proxy'],
    queryFn: getGlobalProxy,
  })

  const setGlobalProxyMutation = useMutation({
    mutationFn: (url: string | null) => setGlobalProxy({ proxyUrl: url }),
    onSuccess: (_, url) => {
      toast.success(url ? `已设置全局代理: ${maskProxyUrl(url)}` : '已清除全局代理')
      queryClient.invalidateQueries({ queryKey: ['global-proxy'] })
    },
    onError: (err) => toast.error(`操作失败: ${extractErrorMessage(err)}`),
  })

  const currentGlobalProxy = globalProxyData?.proxyUrl ?? null

  const addMutation = useMutation({
    mutationFn: () => addProxy({ url: newUrl.trim(), label: newLabel.trim() || undefined }),
    onSuccess: (entry) => {
      toast.success(`代理已添加：${entry.url}`)
      setNewUrl('')
      setNewLabel('')
      queryClient.invalidateQueries({ queryKey: ['proxy-pool'] })
    },
    onError: (err) => toast.error(`添加失败: ${extractErrorMessage(err)}`),
  })

  const batchMutation = useMutation({
    mutationFn: () =>
      batchAddProxies({
        urls: batchText.split('\n').map((l) => l.trim()).filter(Boolean),
      }),
    onSuccess: (res) => {
      if (res.errors === 0) {
        toast.success(`批量导入完成：成功 ${res.added} 个`)
      } else {
        toast.info(`批量导入完成：成功 ${res.added} 个，跳过 ${res.errors} 个`)
      }
      setBatchErrors(res.errorMessages)
      setBatchText('')
      queryClient.invalidateQueries({ queryKey: ['proxy-pool'] })
    },
    onError: (err) => toast.error(`批量导入失败: ${extractErrorMessage(err)}`),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteProxy(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['proxy-pool'] })
    },
    onError: (err) => toast.error(`删除失败: ${extractErrorMessage(err)}`),
  })

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      setProxyEnabled(id, enabled),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['proxy-pool'] })
    },
    onError: (err) => toast.error(`操作失败: ${extractErrorMessage(err)}`),
  })

  const [checkingId, setCheckingId] = useState<number | null>(null)
  const checkMutation = useMutation({
    mutationFn: (id: number) => checkProxy(id),
    onMutate: (id) => setCheckingId(id),
    onSuccess: (res) => {
      if (res.health === 'healthy') {
        toast.success(`代理可用，延迟 ${res.latencyMs ?? '-'} ms`)
      } else {
        toast.error(res.autoDisabled ? '代理探测失败，已自动禁用' : '代理探测失败')
      }
      queryClient.invalidateQueries({ queryKey: ['proxy-pool'] })
    },
    onError: (err) => toast.error(`探测失败: ${extractErrorMessage(err)}`),
    onSettled: () => setCheckingId(null),
  })

  const checkAllMutation = useMutation({
    mutationFn: () => checkAllProxies(),
    onSuccess: (res) => {
      toast.success(
        `健康检查完成：健康 ${res.healthy}，异常 ${res.unhealthy}，自动禁用 ${res.autoDisabled}`
      )
      queryClient.invalidateQueries({ queryKey: ['proxy-pool'] })
    },
    onError: (err) => toast.error(`检查失败: ${extractErrorMessage(err)}`),
  })

  const assignRoundRobinMutation = useMutation({
    mutationFn: () => assignProxiesRoundRobin(null),
    onSuccess: (res) => {
      toast.success(`已用 ${res.proxyCount} 个代理轮询分配给 ${res.assigned} 个凭据`)
      queryClient.invalidateQueries({ queryKey: ['proxy-pool'] })
      queryClient.invalidateQueries({ queryKey: ['credentials'] })
    },
    onError: (err) => toast.error(`分配失败: ${extractErrorMessage(err)}`),
  })

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault()
    if (!newUrl.trim()) return
    addMutation.mutate()
  }

  const handleDelete = async (proxy: ProxyPoolEntry) => {
    if (
      proxy.credentialCount > 0 &&
      !(await confirm({
        title: '删除代理',
        description: `该代理正被 ${proxy.credentialCount} 个凭据使用中，删除后这些凭据将回退到全局代理配置。确定删除吗？`,
        confirmText: '删除',
        destructive: true,
      }))
    )
      return
    deleteMutation.mutate(proxy.id)
  }

  const total = data?.total ?? 0
  const proxies = data?.proxies ?? []
  const enabledCount = proxies.filter((p) => p.enabled).length
  const healthyCount = proxies.filter((p) => p.health === 'healthy').length
  const unhealthyCount = proxies.filter((p) => p.health === 'unhealthy').length

  const renderHealthBadge = (proxy: ProxyPoolEntry) => {
    if (proxy.health === 'healthy') {
      return (
        <Badge variant="outline" className="text-xs gap-1 border-green-500/50 text-green-600 dark:text-green-400">
          <CheckCircle2 className="h-3 w-3" />
          {proxy.latencyMs != null ? `${proxy.latencyMs}ms` : '可用'}
        </Badge>
      )
    }
    if (proxy.health === 'unhealthy') {
      return (
        <Badge variant="outline" className="text-xs gap-1 border-destructive/50 text-destructive">
          <XCircle className="h-3 w-3" />
          异常{proxy.consecutiveFailures > 0 ? ` ×${proxy.consecutiveFailures}` : ''}
        </Badge>
      )
    }
    return (
      <Badge variant="outline" className="text-xs gap-1 text-muted-foreground">
        <HelpCircle className="h-3 w-3" />
        未检测
      </Badge>
    )
  }

  return (
    <div className="space-y-5">
      {/* 标题 */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight leading-tight sm:text-[28px] flex items-center gap-2">
            <Network className="h-6 w-6" />
            代理 IP 池
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            提前添加、批量导入与批量验活代理；可设为全局代理或轮询分配给凭据
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
          刷新
        </Button>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-4">
        <Card>
          <CardContent className="p-3 sm:p-5">
            <div className="text-[11px] font-medium text-muted-foreground sm:text-[13px]">代理总数</div>
            <div className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums sm:mt-2 sm:text-3xl">{total}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 sm:p-5">
            <div className="text-[11px] font-medium text-muted-foreground sm:text-[13px]">已启用</div>
            <div className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums sm:mt-2 sm:text-3xl">{enabledCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 sm:p-5">
            <div className="text-[11px] font-medium text-muted-foreground sm:text-[13px]">健康</div>
            <div className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums text-emerald-600 dark:text-emerald-400 sm:mt-2 sm:text-3xl">{healthyCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 sm:p-5">
            <div className="text-[11px] font-medium text-muted-foreground sm:text-[13px]">异常</div>
            <div className={`mt-1.5 text-2xl font-semibold tracking-tight tabular-nums sm:mt-2 sm:text-3xl ${unhealthyCount > 0 ? 'text-destructive' : ''}`}>{unhealthyCount}</div>
          </CardContent>
        </Card>
      </div>

      {/* 添加 / 批量导入 */}
      <Card>
        <CardContent className="p-4 space-y-3">
          {!showBatch && (
            <form onSubmit={handleAdd} className="flex flex-col gap-2 sm:flex-row">
              <Input
                placeholder="代理 URL（如 socks5://user:pass@host:port）"
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                className="flex-1 font-mono text-sm"
              />
              <Input
                placeholder="备注（可选）"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                className="sm:w-40"
              />
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={addMutation.isPending || !newUrl.trim()}>
                  <Plus className="h-4 w-4 mr-1" />
                  添加
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setShowBatch(true)}>
                  <Upload className="h-4 w-4 mr-1" />
                  批量
                </Button>
              </div>
            </form>
          )}

          {showBatch && (
            <div className="space-y-2">
              <label className="text-sm font-medium">
                批量导入（每行一个代理 URL，# 开头为注释）
              </label>
              <textarea
                placeholder={'# 每行一个代理 URL\nsocks5://user:pass@host1:1080\nsocks5://user:pass@host2:1080\nhttp://user:pass@host3:8080'}
                value={batchText}
                onChange={(e) => setBatchText(e.target.value)}
                className="flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono placeholder:text-muted-foreground focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => batchMutation.mutate()}
                  disabled={batchMutation.isPending || !batchText.trim()}
                >
                  导入
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => { setShowBatch(false); setBatchText(''); setBatchErrors([]) }}
                >
                  {batchMutation.isSuccess ? '关闭' : '取消'}
                </Button>
              </div>
              {batchErrors.length > 0 && (
                <div className="text-xs text-muted-foreground space-y-1 max-h-24 overflow-y-auto border rounded-md p-2">
                  <div className="font-medium text-yellow-600 dark:text-yellow-400">跳过的条目：</div>
                  {batchErrors.map((msg, i) => (
                    <div key={i}>{msg}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 全局代理显示 */}
          <div className="rounded-md border p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Globe className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">全局代理</span>
              </div>
              {currentGlobalProxy && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 text-xs text-destructive hover:text-destructive"
                  onClick={() => setGlobalProxyMutation.mutate(null)}
                  disabled={setGlobalProxyMutation.isPending}
                >
                  清除
                </Button>
              )}
            </div>
            <div className="text-xs font-mono text-muted-foreground">
              {currentGlobalProxy ? maskProxyUrl(currentGlobalProxy) : '未配置（直连）'}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 代理列表 */}
      <Card>
        <CardContent className="p-4 space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-sm text-muted-foreground">共 {total} 个代理</div>
            {total > 0 && (
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => checkAllMutation.mutate()}
                  disabled={checkAllMutation.isPending}
                  title="对所有已启用代理执行健康检查（批量验活）"
                >
                  <Activity className="h-3 w-3 mr-1" />
                  {checkAllMutation.isPending ? '检测中...' : '批量验活'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => assignRoundRobinMutation.mutate()}
                  disabled={assignRoundRobinMutation.isPending}
                  title="将可用代理轮询分配给所有凭据"
                >
                  <Shuffle className="h-3 w-3 mr-1" />
                  轮询分配
                </Button>
              </div>
            )}
          </div>

          {isLoading && (
            <div className="text-sm text-muted-foreground py-8 text-center">加载中...</div>
          )}

          {proxies.length === 0 && !isLoading && (
            <div className="text-sm text-muted-foreground py-8 text-center">
              暂无代理，请在上方添加或批量导入
            </div>
          )}

          {proxies.length > 0 && (
            <div className="border rounded-md divide-y">
              {proxies.map((proxy) => (
                <div key={proxy.id} className="flex items-center gap-3 p-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-xs truncate">{maskProxyUrl(proxy.url)}</span>
                      {proxy.label && (
                        <Badge variant="secondary" className="text-xs">{proxy.label}</Badge>
                      )}
                      {renderHealthBadge(proxy)}
                      {!proxy.enabled && (
                        <Badge variant="outline" className="text-xs text-muted-foreground">
                          {proxy.autoDisabled ? '自动禁用' : '已禁用'}
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5">
                      {proxy.credentialCount > 0 && (
                        <span className="text-xs text-muted-foreground">
                          {proxy.credentialCount} 个凭据使用中
                        </span>
                      )}
                      {proxy.lastCheckedAt && (
                        <span className="text-xs text-muted-foreground">
                          检测于 {new Date(proxy.lastCheckedAt).toLocaleString()}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => checkMutation.mutate(proxy.id)}
                      disabled={checkingId === proxy.id}
                      title="测试此代理连通性"
                    >
                      <Activity className="h-3 w-3 mr-1" />
                      {checkingId === proxy.id ? '测试中' : '测试'}
                    </Button>
                    {proxy.enabled && proxy.url !== currentGlobalProxy && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() => setGlobalProxyMutation.mutate(proxy.url)}
                        disabled={setGlobalProxyMutation.isPending}
                        title="设为全局代理"
                      >
                        <Globe className="h-3 w-3 mr-1" />
                        全局
                      </Button>
                    )}
                    {proxy.url === currentGlobalProxy && (
                      <Badge variant="secondary" className="text-xs h-7">全局</Badge>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0"
                      onClick={() => toggleMutation.mutate({ id: proxy.id, enabled: !proxy.enabled })}
                      title={proxy.enabled ? '禁用此代理' : '启用此代理'}
                    >
                      {proxy.enabled ? (
                        <ToggleRight className="h-4 w-4 text-green-500" />
                      ) : (
                        <ToggleLeft className="h-4 w-4 text-muted-foreground" />
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                      onClick={() => handleDelete(proxy)}
                      disabled={deleteMutation.isPending}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

