import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Select,
  SelectGroup,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { getProxyPool } from '@/api/credentials'
import { maskProxyUrl } from '@/lib/utils'

interface ProxySelectProps {
  /** 当前代理 URL 值。'' = 使用全局配置；'direct' = 直连；其它 = 具体代理 URL */
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  /** 是否拉取代理池（通常传入对话框的 open 状态，关闭时不请求） */
  enabled?: boolean
}

/**
 * 代理选择器：从代理池下拉选择，或手动输入自定义代理 URL。
 *
 * 添加 / 编辑凭据对话框共用。下拉项：
 * - 使用全局代理配置（value = ''）
 * - 直连（value = 'direct'）
 * - 代理池中所有已启用代理
 * - 手动输入...（切到自定义输入框）
 *
 * 当 `value` 是池外的自定义 URL 时，自动展示手动输入框并回填。
 */
export function ProxySelect({ value, onChange, disabled, enabled = true }: ProxySelectProps) {
  const [manualMode, setManualMode] = useState(false)

  const { data: proxyPool } = useQuery({
    queryKey: ['proxy-pool'],
    queryFn: getProxyPool,
    enabled,
  })

  const enabledProxies = proxyPool?.proxies.filter((p) => p.enabled) ?? []

  // 当前 value 是否是自定义值（不匹配任何标准选项）
  const isCustomUrl =
    value !== '' && value !== 'direct' && !enabledProxies.some((p) => p.url === value)

  // 显示手动输入框：明确进入手动模式，或当前值就是自定义值
  const showManualInput = manualMode || isCustomUrl
  const selectValue = showManualInput ? '__custom__' : value === '' ? '__global__' : value

  return (
    <>
      <Select
        value={selectValue}
        onValueChange={(val) => {
          if (val === '__custom__') {
            setManualMode(true)
            // 保留当前 value 作为初始值让用户编辑
          } else {
            setManualMode(false)
            onChange(val === '__global__' ? '' : val)
          }
        }}
        disabled={disabled}
      >
        <SelectTrigger className="h-10 rounded-xl px-3.5">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__global__">使用全局代理配置</SelectItem>
          <SelectItem value="direct">直连（不使用代理）</SelectItem>
          {enabledProxies.length > 0 && (
            <SelectGroup>
              <SelectLabel>代理池</SelectLabel>
              {enabledProxies.map((p) => (
                <SelectItem key={p.id} value={p.url}>
                  {p.label ? `${p.label} | ${maskProxyUrl(p.url)}` : maskProxyUrl(p.url)}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          <SelectItem value="__custom__">手动输入...</SelectItem>
        </SelectContent>
      </Select>

      {/* 自定义 URL 手动输入框 */}
      {showManualInput && (
        <Input
          placeholder="自定义代理 URL（如 socks5://user:pass@host:port）"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="font-mono text-sm"
        />
      )}
    </>
  )
}
