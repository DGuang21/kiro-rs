import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'
import {
  Wallet,
  KeyRound,
  Loader2,
  PackageCheck,
  Zap,
  Info,
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
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'
import { useUpstreams } from '@/hooks/use-upstream'
import {
  queryUpstreamStock,
  queryUpstreamProfile,
  purchaseUpstream,
  type UpstreamProfile,
} from '@/api/upstream'
import { extractErrorMessage } from '@/lib/utils'

interface RestockDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * 一键补货弹窗（对接真实上游 API）。
 *
 * 流程：选上游 → 查余额/库存 → 选数量 → 提号入库（后端原子完成 purchase +
 * 导入为 api_key 凭据 + 代理池轮询分配）→ 显示结果。
 *
 * 说明：真实提号会先扣费再返回 KEY，KEY 只有付款后才知道，因此代理按「代理池轮询」
 * 自动分配（与自动提号一致），不再逐 KEY 预选。
 */
export function RestockDialog({ open, onOpenChange }: RestockDialogProps) {
  const [upstreamId, setUpstreamId] = useState('')
  const [profile, setProfile] = useState<(UpstreamProfile & { max?: number }) | null>(null)
  const [querying, setQuerying] = useState(false)
  const [count, setCount] = useState('')
  const [purchasing, setPurchasing] = useState(false)
  const [result, setResult] = useState<{ purchased: number; imported: number } | null>(null)

  const { data: upstreams } = useUpstreams()
  const queryClient = useQueryClient()

  const list = upstreams ?? []
  const currentUpstream = list.find((u) => u.id === upstreamId) ?? null

  useEffect(() => {
    if (open) {
      setUpstreamId('')
      setProfile(null)
      setCount('')
      setResult(null)
    }
  }, [open])

  // 切换上游时清空查询结果
  useEffect(() => {
    setProfile(null)
    setCount('')
    setResult(null)
  }, [upstreamId])

  const handleQuery = async () => {
    if (!upstreamId) {
      toast.error('请先选择上游')
      return
    }
    setQuerying(true)
    try {
      const [p, s] = await Promise.allSettled([
        queryUpstreamProfile(upstreamId),
        queryUpstreamStock(upstreamId),
      ])
      const merged: UpstreamProfile & { max?: number } = {}
      if (p.status === 'fulfilled') Object.assign(merged, p.value)
      if (s.status === 'fulfilled') merged.max = s.value.max
      setProfile(merged)
      if (p.status === 'rejected' && s.status === 'rejected') {
        toast.error('查询失败: ' + extractErrorMessage(s.reason))
      }
    } finally {
      setQuerying(false)
    }
  }

  const handlePurchase = async () => {
    if (!upstreamId) {
      toast.error('请先选择上游')
      return
    }
    const n = parseInt(count, 10)
    if (!count.trim() || Number.isNaN(n) || n <= 0) {
      toast.error('请填写提货数量（≥ 1）')
      return
    }
    setPurchasing(true)
    try {
      const res = await purchaseUpstream(upstreamId, n)
      setResult({ purchased: res.purchased, imported: res.imported })
      toast.success(`补货完成：出 Key ${res.purchased} 个，入库 ${res.imported} 个`)
      await queryClient.invalidateQueries({ queryKey: ['credentials'] })
    } catch (e) {
      toast.error('补货失败: ' + extractErrorMessage(e))
    } finally {
      setPurchasing(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[88vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PackageCheck className="h-5 w-5" />
            一键补货
          </DialogTitle>
          <DialogDescription>
            选上游 → 查余额 → 提号入库（自动导入为凭据、代理池轮询分配）
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
              <Select value={upstreamId} onValueChange={setUpstreamId} disabled={purchasing}>
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

          {/* 余额 / 库存 */}
          {upstreamId && (
            <div className="rounded-xl border p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">上游余额与库存</span>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={handleQuery} disabled={querying}>
                  {querying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wallet className="h-3.5 w-3.5" />}
                  查询
                </Button>
              </div>
              {profile ? (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  {profile.remaining != null && (
                    <Badge variant="secondary" className="gap-1"><Wallet className="h-3 w-3" />余额 {profile.remaining}</Badge>
                  )}
                  {profile.max != null && (
                    <Badge variant="secondary" className="gap-1"><KeyRound className="h-3 w-3" />可提取 {profile.max} 个</Badge>
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">点击「查询」获取当前上游余额与可提取数量</p>
              )}
            </div>
          )}

          {/* 数量 */}
          {upstreamId && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">补货数量 <span className="text-red-500">*</span></label>
              <Input
                type="number"
                min={1}
                max={profile?.max ?? undefined}
                placeholder={profile?.max ? `1 ~ ${profile.max}` : '手动提货需填写数量'}
                value={count}
                onChange={(e) => setCount(e.target.value)}
                disabled={purchasing}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">手动提货必须指定数量；「按最低消费自动提满」只在 Webhook 自动提号时生效。</p>
            </div>
          )}

          {/* 代理说明 */}
          {upstreamId && (
            <div className="flex items-start gap-2 rounded-xl border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-xs text-sky-700 dark:text-sky-400">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>入库的 KEY 会自动作为 api_key 凭据，并从代理池<b>轮询分配</b>代理（无可用代理时用全局配置）。</span>
            </div>
          )}

          {/* 结果 */}
          {result && (
            <div className="flex flex-wrap items-center gap-3 rounded-xl border p-3 text-sm">
              <Badge variant="secondary" className="gap-1"><Zap className="h-3 w-3" />出 Key {result.purchased}</Badge>
              <Badge variant="secondary" className="gap-1"><PackageCheck className="h-3 w-3" />入库 {result.imported}</Badge>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={purchasing}>
            {result ? '关闭' : '取消'}
          </Button>
          <Button onClick={handlePurchase} disabled={!upstreamId || purchasing || !count.trim()}>
            {purchasing ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <PackageCheck className="h-4 w-4 mr-1" />}
            提号入库
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
