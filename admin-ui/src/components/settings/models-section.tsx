import { useEffect, useState } from 'react'
import { Plus, Trash2, Save } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SettingGroup } from '@/components/console/setting-row'
import { useCustomModels, useSetCustomModels } from '@/hooks/use-credentials'
import { extractErrorMessage } from '@/lib/utils'
import type { CustomModelItem } from '@/types/api'

/** 空模型模板 */
function emptyModel(): CustomModelItem {
  return {
    id: '',
    backendId: '',
    displayName: undefined,
    contextWindow: undefined,
    maxTokens: undefined,
    supportsReasoning: false,
    ownedBy: undefined,
  }
}

/**
 * 模型分区：管理 config.json 中 customModels 数组。
 *
 * 每条自定义模型定义一个客户端别名→Kiro 后端模型 ID 的映射，
 * 可附带上下文窗口、最大 token 数、reasoning 支持等元数据。
 * 改动即时写入 config.json 并运行时生效。
 */
export function ModelsSection() {
  const { data, isLoading } = useCustomModels()
  const { mutate, isPending } = useSetCustomModels()

  const [drafts, setDrafts] = useState<CustomModelItem[]>([])
  const [dirty, setDirty] = useState(false)

  // 从服务端同步到本地草稿
  useEffect(() => {
    if (!data?.models) return
    setDrafts(data.models.map((m) => ({ ...m })))
    setDirty(false)
  }, [data?.models])

  const markDirty = () => setDirty(true)

  const updateField = <K extends keyof CustomModelItem>(
    index: number,
    field: K,
    value: CustomModelItem[K],
  ) => {
    setDrafts((prev) => {
      const next = [...prev]
      next[index] = { ...next[index], [field]: value }
      return next
    })
    markDirty()
  }

  const addRow = () => {
    setDrafts((prev) => [...prev, emptyModel()])
    markDirty()
  }

  const removeRow = (index: number) => {
    setDrafts((prev) => prev.filter((_, i) => i !== index))
    markDirty()
  }

  const apply = () => {
    // 校验
    for (let i = 0; i < drafts.length; i++) {
      const m = drafts[i]
      if (!m.id.trim()) {
        toast.error(`第 ${i + 1} 条模型的 id 不能为空`)
        return
      }
      if (!m.backendId.trim()) {
        toast.error(`第 ${i + 1} 条模型（${m.id || '未命名'}）的 backendId 不能为空`)
        return
      }
    }
    // 清除 undefined 的可选字段以防序列化噪声
    const clean = drafts.map((m) => ({
      ...m,
      displayName: m.displayName?.trim() || undefined,
      ownedBy: m.ownedBy?.trim() || undefined,
      contextWindow: m.contextWindow ?? undefined,
      maxTokens: m.maxTokens ?? undefined,
    }))
    mutate(
      { models: clean },
      {
        onSuccess: () => {
          setDirty(false)
          toast.success(`已保存 ${clean.length} 条自定义模型`)
        },
        onError: (err) => {
          toast.error('保存失败：' + extractErrorMessage(err))
        },
      },
    )
  }

  const count = drafts.length

  return (
    <div className="space-y-4">
      <SettingGroup
        title="自定义模型"
        description="定义客户端模型别名→Kiro 后端模型 ID 的映射。id 匹配大小写不敏感。"
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {count > 0 ? `${count} 条模型` : '暂无自定义模型'}
          </span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={addRow}
              disabled={isPending}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              添加模型
            </Button>
            <Button
              size="sm"
              onClick={apply}
              disabled={isLoading || isPending || !dirty}
            >
              <Save className="mr-1 h-3.5 w-3.5" />
              {isPending ? '保存中…' : '应用'}
            </Button>
          </div>
        </div>

        {count === 0 && !isLoading && (
          <p className="py-6 text-center text-[13px] text-muted-foreground">
            点击「添加模型」创建第一条映射
          </p>
        )}

        {count > 0 && (
          <div className="overflow-x-auto">
            {/* 表头 */}
            <div className="mb-1 grid min-w-[52rem] grid-cols-[1fr_1fr_80px_70px_90px_1fr_100px_36px] gap-1.5 px-1 text-[11px] font-medium text-muted-foreground">
              <span>id</span>
              <span>backendId</span>
              <span>窗口</span>
              <span>tokens</span>
              <span>Reasoning</span>
              <span>displayName</span>
              <span>ownedBy</span>
              <span />
            </div>

            {/* 行 */}
            <div className="space-y-1">
              {drafts.map((m, i) => (
                <div
                  key={i}
                  className="grid min-w-[52rem] grid-cols-[1fr_1fr_80px_70px_90px_1fr_100px_36px] items-center gap-1.5 rounded-md border border-border/60 px-2 py-1.5"
                >
                  <Input
                    value={m.id}
                    onChange={(e) => updateField(i, 'id', e.target.value)}
                    placeholder="my-gpt"
                    disabled={isPending}
                    spellCheck={false}
                    className="h-7 text-[12.5px]"
                  />
                  <Input
                    value={m.backendId}
                    onChange={(e) => updateField(i, 'backendId', e.target.value)}
                    placeholder="gpt-5.7"
                    disabled={isPending}
                    spellCheck={false}
                    className="h-7 text-[12.5px]"
                  />
                  <Input
                    type="number"
                    value={m.contextWindow ?? ''}
                    onChange={(e) => {
                      const v = e.target.value
                      updateField(i, 'contextWindow', v === '' ? undefined : Number(v))
                    }}
                    placeholder="200000"
                    disabled={isPending}
                    className="h-7 text-[12.5px] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                  <Input
                    type="number"
                    value={m.maxTokens ?? ''}
                    onChange={(e) => {
                      const v = e.target.value
                      updateField(i, 'maxTokens', v === '' ? undefined : Number(v))
                    }}
                    placeholder="64000"
                    disabled={isPending}
                    className="h-7 text-[12.5px] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                  <div className="flex justify-center">
                    <Switch
                      checked={m.supportsReasoning ?? false}
                      onCheckedChange={(checked) =>
                        updateField(i, 'supportsReasoning', checked)
                      }
                      disabled={isPending}
                      aria-label={`第 ${i + 1} 条模型 reasoning`}
                    />
                  </div>
                  <Input
                    value={m.displayName ?? ''}
                    onChange={(e) =>
                      updateField(i, 'displayName', e.target.value || undefined)
                    }
                    placeholder="同 id"
                    disabled={isPending}
                    spellCheck={false}
                    className="h-7 text-[12.5px]"
                  />
                  <Input
                    value={m.ownedBy ?? ''}
                    onChange={(e) =>
                      updateField(i, 'ownedBy', e.target.value || undefined)
                    }
                    placeholder="custom"
                    disabled={isPending}
                    spellCheck={false}
                    className="h-7 text-[12.5px]"
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => removeRow(i)}
                    disabled={isPending}
                    title="删除此行"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
      </SettingGroup>
    </div>
  )
}
