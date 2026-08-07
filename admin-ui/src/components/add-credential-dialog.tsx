import { useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CheckCircle2,
  XCircle,
  AlertCircle,
  Loader2,
  Shuffle,
  Eraser,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'
import { useAddCredential } from '@/hooks/use-credentials'
import { useGroupOptions } from '@/hooks/use-groups'
import { extractErrorMessage, maskProxyUrl } from '@/lib/utils'
import { GroupMultiSelect } from '@/components/group-select'
import { ProxySelect } from '@/components/proxy-select'
import {
  batchImportCredentials,
  getProxyPool,
  type BatchImportItemEvent,
  type BatchImportSummary,
} from '@/api/credentials'
import type { AddCredentialRequest } from '@/types/api'

interface AddCredentialDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  metadataSchema?: CredentialMetadataSchema
}

type AuthMethod = 'social' | 'idc' | 'api_key' | 'external_idp'
// 批量添加单行结果（映射 batch-import SSE 事件）
interface BatchRowResult {
  index: number
  status: 'pending' | 'verifying' | 'verified' | 'imported' | 'duplicate' | 'failed'
  error?: string
  usage?: string
  email?: string
  proxyUrl?: string
}

// Region 快速预设。与后端保持一致：
// - Auth Region 决定 Token 刷新域名（prod.<authRegion>.auth.desktop.kiro.dev / oidc.<authRegion>.amazonaws.com）
// - API Region 决定 API 请求域名（q.<apiRegion>.amazonaws.com）
const REGION_PRESETS = {
  us: { authRegion: 'us-east-1', apiRegion: 'us-east-1' },
  eu: { authRegion: 'eu', apiRegion: 'eu-central-1' },
} as const

type RegionPresetKey = keyof typeof REGION_PRESETS
// 'global' = 两者留空走全局配置；'custom' = 手动填了不匹配预设的值
type RegionSelection = RegionPresetKey | 'global' | 'custom'

const REGION_OPTIONS: { value: RegionPresetKey | 'global'; label: string }[] = [
  { value: 'global', label: '默认（全局）' },
  { value: 'us', label: 'US 美国区' },
  { value: 'eu', label: 'EU 欧洲区' },
]

// 由当前两个输入框反推选中的预设，保证手动改值后高亮状态同步
function matchRegionPreset(authRegion: string, apiRegion: string): RegionSelection {
  const auth = authRegion.trim()
  const api = apiRegion.trim()
  if (!auth && !api) return 'global'
  for (const [key, preset] of Object.entries(REGION_PRESETS)) {
    if (auth === preset.authRegion && api === preset.apiRegion) return key as RegionPresetKey
  }
  return 'custom'
}

// 把批量文本框按行拆成去重后的凭据列表（忽略空行与 # 注释）
function parseBatchLines(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (seen.has(line)) continue
    seen.add(line)
    out.push(line)
  }
  return out
}

export function AddCredentialDialog({ open, onOpenChange, metadataSchema }: AddCredentialDialogProps) {
  const [refreshToken, setRefreshToken] = useState('')
  const [kiroApiKey, setKiroApiKey] = useState('')
  const [authMethod, setAuthMethod] = useState<AuthMethod>('social')
  const [authRegion, setAuthRegion] = useState('')
  const [apiRegion, setApiRegion] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [tokenEndpoint, setTokenEndpoint] = useState('')
  const [issuerUrl, setIssuerUrl] = useState('')
  const [scopes, setScopes] = useState('')
  const [machineId, setMachineId] = useState('')
  const [proxyUrl, setProxyUrl] = useState('')
  const [proxyUsername, setProxyUsername] = useState('')
  const [proxyPassword, setProxyPassword] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [groups, setGroups] = useState<string[]>([])
  const [sourceChannel, setSourceChannel] = useState('')
  const [metadata, setMetadata] = useState<CredentialMetadata>({
    type: 'normal',
    saleStatus: 'not_for_sale',
  })

  // 批量添加相关状态
  const [batchMode, setBatchMode] = useState(false)
  const [batchText, setBatchText] = useState('')
  // 每行凭据 → 指定代理 URL（'' 表示用全局；'direct' 直连）。以行内容为 key，
  // 编辑文本时未变化的行保留已选代理。
  const [rowProxy, setRowProxy] = useState<Record<string, string>>({})
  const [importing, setImporting] = useState(false)
  const [progressTotal, setProgressTotal] = useState(0)
  const [results, setResults] = useState<BatchRowResult[]>([])
  const abortRef = useRef<AbortController | null>(null)

  const groupOptions = useGroupOptions()
  const queryClient = useQueryClient()
  const { mutate, isPending } = useAddCredential()

  const { data: proxyPool } = useQuery({
    queryKey: ['proxy-pool'],
    queryFn: getProxyPool,
    enabled: open,
  })
  const enabledProxies = useMemo(
    () => proxyPool?.proxies.filter((p) => p.enabled) ?? [],
    [proxyPool],
  )

  const isApiKey = authMethod === 'api_key'
  const isExternalIdp = authMethod === 'external_idp'
  // idc 的 clientId/clientSecret 是每凭据独有，不适合批量；仅这些方式支持批量
  const batchSupported = authMethod === 'social' || isApiKey || isExternalIdp
  const useBatch = batchMode && batchSupported

  const batchLines = useMemo(() => parseBatchLines(batchText), [batchText])

  // 当前选中的 Region 预设由输入框值反推，手动编辑后自动落到 custom
  const regionSelection = useMemo(
    () => matchRegionPreset(authRegion, apiRegion),
    [authRegion, apiRegion],
  )

  // 快速选择：global 清空两者（走全局配置），us/eu 回填对应 Region
  const applyRegionPreset = (value: RegionPresetKey | 'global') => {
    if (value === 'global') {
      setAuthRegion('')
      setApiRegion('')
      return
    }
    const preset = REGION_PRESETS[value]
    setAuthRegion(preset.authRegion)
    setApiRegion(preset.apiRegion)
  }

  const resetForm = () => {
    setRefreshToken('')
    setKiroApiKey('')
    setAuthMethod('social')
    setAuthRegion('')
    setApiRegion('')
    setClientId('')
    setClientSecret('')
    setTokenEndpoint('')
    setIssuerUrl('')
    setScopes('')
    setMachineId('')
    setProxyUrl('')
    setProxyUsername('')
    setProxyPassword('')
    setEndpoint('')
    setGroups([])
    setSourceChannel('')
    setBatchMode(false)
    setBatchText('')
    setRowProxy({})
    setProgressTotal(0)
    setResults([])
  }

  // 把代理池按行轮流分配给每行凭据（打乱后 round-robin，尽量不重复）
  const assignRandomProxies = () => {
    if (enabledProxies.length === 0) {
      toast.error('代理池没有可用代理')
      return
    }
    if (batchLines.length === 0) {
      toast.error('请先在上方粘贴要添加的凭据')
      return
    }
    const shuffled = [...enabledProxies].sort(() => Math.random() - 0.5)
    const next: Record<string, string> = {}
    batchLines.forEach((line, i) => {
      next[line] = shuffled[i % shuffled.length].url
    })
    setRowProxy(next)
    toast.success(`已为 ${batchLines.length} 个凭据随机分配代理`)
  }

  const clearRowProxies = () => setRowProxy({})

  // 单个添加（原逻辑）
  const handleSingleSubmit = () => {
    if (isApiKey) {
      if (!kiroApiKey.trim()) {
        toast.error('请输入 Kiro API Key')
        return
      }
    } else {
      if (!refreshToken.trim()) {
        toast.error('请输入 Refresh Token')
        return
      }
      if (authMethod === 'idc' && (!clientId.trim() || !clientSecret.trim())) {
        toast.error('IdC/Builder-ID/IAM 认证需要填写 Client ID 和 Client Secret')
        return
      }
      if (isExternalIdp && (!clientId.trim() || !tokenEndpoint.trim())) {
        toast.error('企业 SSO (external_idp) 需要填写 Client ID 和 Token 端点')
        return
      }
    }

    mutate(
      {
        authMethod,
        provider: isExternalIdp ? 'AzureAD' : undefined,
        refreshToken: isApiKey ? undefined : refreshToken.trim(),
        kiroApiKey: isApiKey ? kiroApiKey.trim() : undefined,
        authRegion: authRegion.trim() || undefined,
        apiRegion: apiRegion.trim() || undefined,
        clientId: isApiKey ? undefined : clientId.trim() || undefined,
        clientSecret: isApiKey || isExternalIdp ? undefined : clientSecret.trim() || undefined,
        tokenEndpoint: isExternalIdp ? tokenEndpoint.trim() || undefined : undefined,
        issuerUrl: isExternalIdp ? issuerUrl.trim() || undefined : undefined,
        scopes: isExternalIdp ? scopes.trim() || undefined : undefined,
        machineId: machineId.trim() || undefined,
        proxyUrl: proxyUrl.trim() || undefined,
        proxyUsername: proxyUsername.trim() || undefined,
        proxyPassword: proxyPassword.trim() || undefined,
        endpoint: endpoint.trim() || undefined,
        groups: groups,
        sourceChannel: sourceChannel.trim() || undefined,
        metadata,
      },
      {
        onSuccess: (data) => {
          toast.success(data.message)
          onOpenChange(false)
          resetForm()
        },
        onError: (error: unknown) => {
          toast.error(`添加失败: ${extractErrorMessage(error)}`)
        },
      },
    )
  }

  // 按原始行下标局部更新单行结果
  const updateResult = (i: number, patch: Partial<BatchRowResult>) => {
    setResults((prev) => {
      const next = [...prev]
      next[i] = { ...next[i], ...patch }
      return next
    })
  }

  // 批量添加：构造请求 → 复用 batch-import 端点（验活 + 失败回滚）
  const handleBatchSubmit = async () => {
    if (batchLines.length === 0) {
      toast.error(isApiKey ? '请粘贴要添加的 API Key（每行一个）' : '请粘贴要添加的 Refresh Token（每行一个）')
      return
    }
    if (isExternalIdp && (!clientId.trim() || !tokenEndpoint.trim())) {
      toast.error('企业 SSO (external_idp) 需要填写共享的 Client ID 和 Token 端点')
      return
    }

    // 共享字段（所有行一致），逐行只变化凭据本身与代理
    const buildReq = (line: string): AddCredentialRequest => {
      const rowUrl = rowProxy[line]?.trim()
      const base: AddCredentialRequest = {
        authRegion: authRegion.trim() || undefined,
        apiRegion: apiRegion.trim() || undefined,
        endpoint: endpoint.trim() || undefined,
        groups,
        sourceChannel: sourceChannel.trim() || undefined,
        proxyUrl: rowUrl || undefined,
        proxyUsername: proxyUsername.trim() || undefined,
        proxyPassword: proxyPassword.trim() || undefined,
      }
      if (isApiKey) {
        return { ...base, authMethod: 'api_key', kiroApiKey: line }
      }
      if (isExternalIdp) {
        return {
          ...base,
          authMethod: 'external_idp',
          provider: 'AzureAD',
          refreshToken: line,
          clientId: clientId.trim() || undefined,
          tokenEndpoint: tokenEndpoint.trim() || undefined,
          issuerUrl: issuerUrl.trim() || undefined,
          scopes: scopes.trim() || undefined,
        }
      }
      return { ...base, authMethod: 'social', refreshToken: line }
    }

    const reqs = batchLines.map(buildReq)

    setImporting(true)
    setProgressTotal(reqs.length)
    setResults(
      batchLines.map((line, i) => ({
        index: i + 1,
        status: 'verifying',
        proxyUrl: rowProxy[line]?.trim() || undefined,
      })),
    )

    try {
      const controller = new AbortController()
      abortRef.current = controller
      await batchImportCredentials(
        { credentials: reqs, concurrency: 8, verify: true },
        (ev: BatchImportItemEvent) => {
          const i = ev.index
          if (i < 0 || i >= reqs.length) return
          if (ev.status === 'verified') {
            updateResult(i, { status: 'verified', usage: ev.usage, email: ev.email })
          } else if (ev.status === 'imported') {
            updateResult(i, { status: 'imported', email: ev.email })
          } else if (ev.status === 'duplicate') {
            updateResult(i, { status: 'duplicate', error: ev.error || '该凭据已存在' })
          } else {
            updateResult(i, { status: 'failed', error: ev.error })
          }
        },
        (s: BatchImportSummary) => {
          if (s.failed === 0 && s.duplicate === 0) {
            toast.success(`成功添加并验活 ${s.verified} 个凭据`)
          } else {
            toast.info(
              `完成：成功 ${s.verified} 个，重复 ${s.duplicate} 个，失败 ${s.failed} 个（已排除 ${s.rolledBack}）`,
            )
            if (s.rolledBack < s.failed) {
              toast.warning(`有 ${s.failed - s.rolledBack} 个失败凭据回滚未完成，请手动处理`)
            }
          }
        },
        controller.signal,
      )
      await queryClient.invalidateQueries({ queryKey: ['credentials'] })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        toast.info('已停止添加（已完成的凭据保留）')
        await queryClient.invalidateQueries({ queryKey: ['credentials'] })
      } else {
        toast.error('批量添加失败: ' + extractErrorMessage(error))
      }
    } finally {
      abortRef.current = null
      setImporting(false)
    }
  }

  // 关闭对话框：导入中则中断，否则重置
  const handleClose = (nextOpen: boolean) => {
    if (!nextOpen) {
      if (importing) {
        abortRef.current?.abort()
      } else {
        resetForm()
      }
    }
    onOpenChange(nextOpen)
  }

  const finalizedCount = results.filter(
    (r) =>
      r.status === 'verified' ||
      r.status === 'imported' ||
      r.status === 'duplicate' ||
      r.status === 'failed',
  ).length

  const getStatusIcon = (status: BatchRowResult['status']) => {
    switch (status) {
      case 'pending':
        return <div className="w-5 h-5 rounded-full border-2 border-gray-300" />
      case 'verifying':
        return <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
      case 'verified':
        return <CheckCircle2 className="w-5 h-5 text-green-500" />
      case 'imported':
        return <CheckCircle2 className="w-5 h-5 text-sky-500" />
      case 'duplicate':
        return <AlertCircle className="w-5 h-5 text-yellow-500" />
      case 'failed':
        return <XCircle className="w-5 h-5 text-red-500" />
    }
  }
  const hasResults = results.length > 0

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{useBatch ? '批量添加凭据' : '添加凭据'}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col min-h-0 flex-1">
          <div className="space-y-4 py-4 overflow-y-auto flex-1 pr-1">
            {/* 认证方式 */}
            <div className="space-y-2">
              <label htmlFor="authMethod" className="text-sm font-medium">
                认证方式
              </label>
              <Select
                value={authMethod}
                onValueChange={(v) => setAuthMethod(v as AuthMethod)}
                disabled={isPending || importing}
              >
                <SelectTrigger id="authMethod" className="h-10 rounded-xl px-3.5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="social">Social</SelectItem>
                  <SelectItem value="idc">IdC/Builder-ID/IAM</SelectItem>
                  <SelectItem value="external_idp">企业 SSO (Microsoft Entra / Azure AD)</SelectItem>
                  <SelectItem value="api_key">API Key</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* 批量添加开关（idc 不支持） */}
            <div className="flex items-center justify-between gap-2 rounded-xl border bg-secondary/30 px-3.5 py-2.5">
              <div className="min-w-0">
                <div className="text-sm font-medium">批量添加</div>
                <p className="text-xs text-muted-foreground leading-snug">
                  {batchSupported
                    ? '开启后可粘贴多个 Token / API Key（每行一个），并为每个指定不同代理'
                    : 'IdC 的 Client ID / Secret 为每凭据独有，不支持批量'}
                </p>
              </div>
              <Switch
                checked={useBatch}
                disabled={!batchSupported || isPending || importing}
                onCheckedChange={(v) => {
                  setBatchMode(v)
                  setResults([])
                }}
              />
            </div>
            {/* __FIELDS__ */}

            {/* 凭据输入：单个 or 批量 */}
            {isApiKey ? (
              useBatch ? (
                <div className="space-y-2">
                  <label className="text-sm font-medium">
                    Kiro API Key 列表 <span className="text-red-500">*</span>
                  </label>
                  <textarea
                    placeholder={'每行一个 API Key（# 开头为注释）\nksk_xxxxxxxx\nksk_yyyyyyyy'}
                    value={batchText}
                    onChange={(e) => setBatchText(e.target.value)}
                    disabled={importing}
                    autoComplete="off"
                    className="flex min-h-[120px] w-full rounded-xl border border-input bg-background/60 px-3.5 py-2.5 text-sm font-mono placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30 disabled:opacity-50"
                  />
                  <p className="text-xs text-muted-foreground">已解析 {batchLines.length} 个 API Key（自动去重）</p>
                </div>
              ) : (
                <div className="space-y-2">
                  <label htmlFor="kiroApiKey" className="text-sm font-medium">
                    Kiro API Key <span className="text-red-500">*</span>
                  </label>
                  <Input
                    id="kiroApiKey"
                    type="password"
                    placeholder="格式: ksk_xxxxxxxx"
                    value={kiroApiKey}
                    onChange={(e) => setKiroApiKey(e.target.value)}
                    disabled={isPending}
                    autoComplete="new-password"
                  />
                </div>
              )
            ) : useBatch ? (
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  Refresh Token 列表 <span className="text-red-500">*</span>
                </label>
                <textarea
                  placeholder={'每行一个 Refresh Token（# 开头为注释）'}
                  value={batchText}
                  onChange={(e) => setBatchText(e.target.value)}
                  disabled={importing}
                  autoComplete="off"
                  className="flex min-h-[120px] w-full rounded-xl border border-input bg-background/60 px-3.5 py-2.5 text-sm font-mono placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30 disabled:opacity-50"
                />
                <p className="text-xs text-muted-foreground">已解析 {batchLines.length} 个 Token（自动去重）</p>
              </div>
            ) : (
              <div className="space-y-2">
                <label htmlFor="refreshToken" className="text-sm font-medium">
                  Refresh Token <span className="text-red-500">*</span>
                </label>
                <Input
                  id="refreshToken"
                  type="password"
                  placeholder="请输入 Refresh Token"
                  value={refreshToken}
                  onChange={(e) => setRefreshToken(e.target.value)}
                  disabled={isPending}
                  autoComplete="new-password"
                />
              </div>
            )}

            {/* Region 配置 */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Region 配置</label>
              {/* 快速选择：一键回填 Auth / API Region */}
              <div
                className="grid grid-cols-3 rounded-md border p-1"
                role="radiogroup"
                aria-label="Region 快速选择"
              >
                {REGION_OPTIONS.map((opt) => (
                  <Button
                    key={opt.value}
                    type="button"
                    size="sm"
                    variant={regionSelection === opt.value ? 'default' : 'ghost'}
                    role="radio"
                    aria-checked={regionSelection === opt.value}
                    onClick={() => applyRegionPreset(opt.value)}
                    disabled={isPending || importing}
                    className="h-8"
                  >
                    {opt.label}
                  </Button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  id="authRegion"
                  placeholder="Auth Region"
                  value={authRegion}
                  onChange={(e) => setAuthRegion(e.target.value)}
                  disabled={isPending || importing}
                  autoComplete="off"
                />
                <Input
                  id="apiRegion"
                  placeholder="API Region"
                  value={apiRegion}
                  onChange={(e) => setApiRegion(e.target.value)}
                  disabled={isPending || importing}
                  autoComplete="off"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {regionSelection === 'custom'
                  ? '当前为自定义 Region。Auth Region 用于 Token 刷新，API Region 用于 API 请求'
                  : '可用上方按钮快速切换，也可手动填写。均留空则使用全局配置。Auth Region 用于 Token 刷新，API Region 用于 API 请求'}
              </p>
            </div>

            {/* IdC/Builder-ID/IAM 额外字段（仅单个模式，idc 不支持批量） */}
            {authMethod === 'idc' && (
              <>
                <div className="space-y-2">
                  <label htmlFor="clientId" className="text-sm font-medium">
                    Client ID <span className="text-red-500">*</span>
                  </label>
                  <Input
                    id="clientId"
                    placeholder="请输入 Client ID"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    disabled={isPending}
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-2">
                  <label htmlFor="clientSecret" className="text-sm font-medium">
                    Client Secret <span className="text-red-500">*</span>
                  </label>
                  <Input
                    id="clientSecret"
                    type="password"
                    placeholder="请输入 Client Secret"
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    disabled={isPending}
                    autoComplete="new-password"
                  />
                </div>
              </>
            )}

            {/* 企业 SSO (external_idp) 共享字段 */}
            {isExternalIdp && (
              <>
                <div className="space-y-2">
                  <label htmlFor="extClientId" className="text-sm font-medium">
                    Client ID <span className="text-red-500">*</span>
                    {useBatch && <span className="ml-1 text-xs text-muted-foreground">（所有凭据共用）</span>}
                  </label>
                  <Input
                    id="extClientId"
                    placeholder="IdP 应用（public client）的 Client ID"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    disabled={isPending || importing}
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-2">
                  <label htmlFor="tokenEndpoint" className="text-sm font-medium">
                    Token 端点 <span className="text-red-500">*</span>
                    {useBatch && <span className="ml-1 text-xs text-muted-foreground">（所有凭据共用）</span>}
                  </label>
                  <Input
                    id="tokenEndpoint"
                    placeholder="https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token"
                    value={tokenEndpoint}
                    onChange={(e) => setTokenEndpoint(e.target.value)}
                    disabled={isPending || importing}
                    autoComplete="off"
                  />
                  <p className="text-xs text-muted-foreground">
                    仅允许 *.microsoftonline.com / .us / .cn 主机（https）
                  </p>
                </div>
                <div className="space-y-2">
                  <label htmlFor="issuerUrl" className="text-sm font-medium">Issuer URL</label>
                  <Input
                    id="issuerUrl"
                    placeholder="https://login.microsoftonline.com/<tenant>/v2.0（可选）"
                    value={issuerUrl}
                    onChange={(e) => setIssuerUrl(e.target.value)}
                    disabled={isPending || importing}
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-2">
                  <label htmlFor="scopes" className="text-sm font-medium">Scopes</label>
                  <Input
                    id="scopes"
                    placeholder="空格分隔，需含 offline_access（可选）"
                    value={scopes}
                    onChange={(e) => setScopes(e.target.value)}
                    disabled={isPending || importing}
                    autoComplete="off"
                  />
                </div>
              </>
            )}

            {/* Machine ID（仅单个模式；批量各凭据自动派生） */}
            {!useBatch && (
              <div className="space-y-2">
                <label htmlFor="machineId" className="text-sm font-medium">Machine ID</label>
                <Input
                  id="machineId"
                  placeholder="留空使用配置中字段, 否则由刷新Token自动派生"
                  value={machineId}
                  onChange={(e) => setMachineId(e.target.value)}
                  disabled={isPending}
                  autoComplete="off"
                />
                <p className="text-xs text-muted-foreground">
                  可选，64 位十六进制字符串，留空使用配置中字段, 否则由刷新Token自动派生
                </p>
              </div>
            )}

            {/* 端点 */}
            <div className="space-y-2">
              <label htmlFor="endpoint" className="text-sm font-medium">端点</label>
              <Input
                id="endpoint"
                placeholder="留空使用默认端点（如 ide / cli）"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                disabled={isPending || importing}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                可选。决定该凭据走哪套 Kiro API。留空使用全局 defaultEndpoint
              </p>
            </div>

            {/* 账号分组 */}
            <div className="space-y-2">
              <label className="text-sm font-medium">账号分组</label>
              <GroupMultiSelect
                value={groups}
                options={groupOptions}
                onChange={setGroups}
                disabled={isPending || importing}
              />
              <p className="text-xs text-muted-foreground">
                可选。绑定了某分组的客户端 Key 只会调度到含该分组的账号{useBatch && '（所有凭据共用）'}
              </p>
            </div>

            {/* 账号来源渠道 */}
            <div className="space-y-2">
              <label htmlFor="sourceChannel" className="text-sm font-medium">账号来源渠道（备注）</label>
              <Input
                id="sourceChannel"
                placeholder="例: 官方, 转售商A, 采购平台X"
                value={sourceChannel}
                onChange={(e) => setSourceChannel(e.target.value)}
                disabled={isPending || importing}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                可选。纯备注，标记账号来源/渠道，便于追踪{useBatch && '（所有凭据共用）'}
              </p>
            </div>

            {/* __PROXY__ */}

            {/* 代理配置 */}
            <div className="space-y-2">
              <label className="text-sm font-medium">代理配置</label>

              {useBatch ? (
                <div className="space-y-2">
                  {/* 逐行分配代理：随机分配 / 清除 */}
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={assignRandomProxies}
                      disabled={importing || enabledProxies.length === 0 || batchLines.length === 0}
                      title="将代理池中的可用代理随机（不重复）分配给每个凭据"
                    >
                      <Shuffle className="h-3.5 w-3.5 mr-1" />
                      随机分配代理
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={clearRowProxies}
                      disabled={importing || Object.keys(rowProxy).length === 0}
                    >
                      <Eraser className="h-3.5 w-3.5 mr-1" />
                      清除
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      代理池可用 {enabledProxies.length} 个
                    </span>
                  </div>

                  {/* 每行凭据一个代理下拉 */}
                  {batchLines.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      粘贴凭据后，可在此为每个凭据单独指定代理（留空则用全局配置）
                    </p>
                  ) : (
                    <div className="space-y-1.5 max-h-[220px] overflow-y-auto rounded-xl border p-2">
                      {batchLines.map((line, i) => (
                        <div key={line} className="flex items-center gap-2">
                          <span className="w-6 shrink-0 text-center text-xs text-muted-foreground tabular-nums">
                            {i + 1}
                          </span>
                          <span className="w-24 shrink-0 truncate font-mono text-xs" title={line}>
                            {line.length > 12 ? `${line.slice(0, 6)}…${line.slice(-4)}` : line}
                          </span>
                          <div className="flex-1 min-w-0">
                            <Select
                              value={rowProxy[line] ? rowProxy[line] : '__global__'}
                              onValueChange={(v) =>
                                setRowProxy((prev) => ({
                                  ...prev,
                                  [line]: v === '__global__' ? '' : v,
                                }))
                              }
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
                  )}
                </div>
              ) : (
                <ProxySelect
                  value={proxyUrl}
                  onChange={setProxyUrl}
                  disabled={isPending}
                  enabled={open}
                />
              )}

              {/* 代理认证（单个 / 批量共用；URL 内含凭据时可留空） */}
              <div className="grid grid-cols-2 gap-2">
                <Input
                  id="proxyUsername"
                  placeholder="代理用户名"
                  value={proxyUsername}
                  onChange={(e) => setProxyUsername(e.target.value)}
                  disabled={isPending || importing}
                  autoComplete="off"
                />
                <Input
                  id="proxyPassword"
                  type="password"
                  placeholder="代理密码"
                  value={proxyPassword}
                  onChange={(e) => setProxyPassword(e.target.value)}
                  disabled={isPending || importing}
                  autoComplete="new-password"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {useBatch
                  ? '可为每个凭据单独指定代理池中的代理；用户名/密码对所有凭据生效'
                  : '可从代理池选择、直连或手动输入。留空使用全局代理，输入 "direct" 可显式不使用代理'}
              </p>
            </div>

            {/* 批量进度 + 结果 */}
            {useBatch && (importing || hasResults) && (
              <div className="space-y-2 rounded-xl border p-3">
                <div className="flex justify-between text-sm">
                  <span>{importing ? '添加进度' : '添加完成'}</span>
                  <span className="tabular-nums">{finalizedCount} / {progressTotal}</span>
                </div>
                <div className="w-full bg-secondary rounded-full h-2">
                  <div
                    className="bg-primary h-2 rounded-full transition-all"
                    style={{ width: `${progressTotal > 0 ? (finalizedCount / progressTotal) * 100 : 0}%` }}
                  />
                </div>
                <div className="flex flex-wrap gap-3 text-xs">
                  <span className="text-green-600 dark:text-green-400">✓ 验活 {results.filter((r) => r.status === 'verified').length}</span>
                  <span className="text-yellow-600 dark:text-yellow-400">⚠ 重复 {results.filter((r) => r.status === 'duplicate').length}</span>
                  <span className="text-red-600 dark:text-red-400">✗ 失败 {results.filter((r) => r.status === 'failed').length}</span>
                </div>
                <div className="border rounded-md divide-y max-h-[200px] overflow-y-auto">
                  {results.map((r) => (
                    <div key={r.index} className="flex items-start gap-2 p-2">
                      {getStatusIcon(r.status)}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium">{r.email || `凭据 #${r.index}`}</span>
                          {r.usage && <span className="text-[11px] text-muted-foreground">{r.usage}</span>}
                        </div>
                        {r.proxyUrl && (
                          <div className="text-[11px] text-muted-foreground font-mono truncate">
                            代理: {maskProxyUrl(r.proxyUrl)}
                          </div>
                        )}
                        {r.error && (
                          <div className="text-[11px] text-red-600 dark:text-red-400">{r.error}</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          {/* __FOOTER__ */}
          <DialogFooter>
            {importing ? (
              <Button type="button" variant="destructive" onClick={() => abortRef.current?.abort()}>
                停止添加
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleClose(false)}
                  disabled={isPending}
                >
                  {hasResults ? '关闭' : '取消'}
                </Button>
                {useBatch ? (
                  !hasResults && (
                    <Button
                      type="button"
                      onClick={handleBatchSubmit}
                      disabled={batchLines.length === 0}
                    >
                      批量添加并验活（{batchLines.length}）
                    </Button>
                  )
                ) : (
                  <Button type="button" onClick={handleSingleSubmit} disabled={isPending}>
                    {isPending ? '添加中...' : '添加'}
                  </Button>
                )}
              </>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}



