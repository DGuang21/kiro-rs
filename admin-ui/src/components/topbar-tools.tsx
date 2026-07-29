import { useState } from 'react'
import {
  RefreshCw, UploadCloud, Settings, Key, Wand2, Eye, EyeOff, Copy,
  MoreHorizontal, Boxes,
} from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu'
import { useUpdateCheck } from '@/hooks/use-update-check'
import { updateAdminKey } from '@/api/credentials'
import { extractErrorMessage, generateApiKey } from '@/lib/utils'
import { ImageUpdateDialog } from '@/components/image-update-dialog'
import { AvailableModelsDialog } from '@/components/available-models-dialog'

/**
 * 顶栏右侧通用工具栏：可用模型、刷新、在线更新、设置（Key 管理）。
 *
 * 只保留高频操作。负载均衡模式、账号级风控故障转移、失败重试次数、凭据自愈
 * 这些配置项已移到「系统设置」Tab（`#/settings`），不再挤在顶栏下拉里。
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
    openImageUpdate: () => setImageUpdateOpen(true),
    openModels: () => setModelsDialogOpen(true),
    openKeyDialog,
    updateCheck,
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
  openImageUpdate: () => void
  openKeyDialog: () => void
  openModels: () => void
  updateCheck?: { hasUpdate: boolean; latestVersion: string; currentVersion: string }
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
      <ModelsButton onOpen={controls.openModels} />
      <RefreshButton onRefresh={controls.handleRefresh} />
      <ImageUpdateButton controls={controls} />
      <KeySettingsMenu onOpenKeyDialog={controls.openKeyDialog} />
    </>
  )
}

function CompactTools({ controls }: { controls: ToolControls }) {
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
        <DropdownMenuItem onSelect={controls.handleRefresh}>
          <RefreshCw />刷新数据
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={controls.openModels}>
          <Boxes />可用模型
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={controls.openImageUpdate}>
          <UploadCloud />镜像在线更新
        </DropdownMenuItem>
        <DropdownMenuLabel>密钥管理</DropdownMenuLabel>
        <DropdownMenuItem onSelect={controls.openKeyDialog}>
          <Key />修改登录API密钥（管理面板登录）
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
