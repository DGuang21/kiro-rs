import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  SettingGroup,
  SettingRow,
  useFieldSaver,
} from '@/components/console/setting-row'
import { useGlobalProxy, useSetGlobalProxy } from '@/hooks/use-credentials'
import { maskProxyUrl } from '@/lib/utils'
import { reportSaveError } from '@/components/settings/report-error'

/**
 * 网络分区：全局出站代理。
 *
 * 这一项是即时保存范式里唯一的例外，理由具体：代理地址填错会让**所有**上游请求
 * 立刻失败，而失焦即提交意味着输到一半切走焦点就会生效。所以这里要求显式「应用」，
 * 并且做基本的协议校验。
 *
 * 按凭据分配的代理池仍在凭据页的「IP 代理池管理」里 —— 那是每凭据的绑定关系，
 * 属于凭据数据而非全局配置。
 */
const PROXY_SCHEMES = ['http://', 'https://', 'socks5://', 'socks5h://']

export function NetworkSection() {
  const { data, isLoading } = useGlobalProxy()
  const { mutate } = useSetGlobalProxy()
  const saver = useFieldSaver(mutate, reportSaveError)
  const isPending = saver.isSaving('proxy')
  const saved = saver.isSaved('proxy')
  const current = data?.proxyUrl ?? null
  const [draft, setDraft] = useState('')

  useEffect(() => {
    setDraft(current ?? '')
  }, [current])

  const apply = () => {
    const url = draft.trim()
    if (!url) {
      toast.error('代理地址不能为空。要停用请点「清除」。')
      return
    }
    if (!PROXY_SCHEMES.some((s) => url.toLowerCase().startsWith(s))) {
      toast.error(`代理地址需以 ${PROXY_SCHEMES.join(' / ')} 开头`)
      return
    }
    if (url === current) return
    saver.save('proxy', { proxyUrl: url })
  }

  const clear = () => {
    saver.save('proxy', { proxyUrl: null })
  }

  return (
    <SettingGroup
      title="全局出站代理"
      description="所有上游请求默认走这个代理；未绑定专属代理的凭据都受它影响"
    >
      <SettingRow
        label="代理地址"
        hint={
          current
            ? `当前生效：${maskProxyUrl(current)}`
            : '未配置，直连上游。支持 http / https / socks5，可带 user:pass 认证'
        }
        pending={isPending}
        saved={saved}
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') apply()
              if (e.key === 'Escape') setDraft(current ?? '')
            }}
            placeholder="socks5://user:pass@host:1080"
            disabled={isLoading || isPending}
            spellCheck={false}
            autoComplete="off"
            className="console-num h-8 w-[min(20rem,60vw)] text-[12.5px]"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={apply}
            disabled={isLoading || isPending || !draft.trim() || draft.trim() === current}
          >
            应用
          </Button>
          {current && (
            <Button
              size="sm"
              variant="ghost"
              onClick={clear}
              disabled={isPending}
              title="停用全局代理，恢复直连"
            >
              清除
            </Button>
          )}
        </div>
      </SettingRow>
    </SettingGroup>
  )
}
