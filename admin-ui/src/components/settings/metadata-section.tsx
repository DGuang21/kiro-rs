import { useEffect, useState } from 'react'
import {
  Plus,
  Save,
  Trash2,
  ChevronUp,
  ChevronDown,
  ChevronRight,
  Palette,
  Sliders,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingGroup } from '@/components/console/setting-row'
import { useQueryClient } from '@tanstack/react-query'
import {
  useCredentialMetadataSchema,
  useSetCredentialMetadataSchema,
} from '@/hooks/use-credentials'
import { extractErrorMessage } from '@/lib/utils'
import { validateMetadataCss, metadataCssToStyle } from '@/lib/credential-metadata-style'
import type {
  CredentialMetadataFieldSchema,
  CredentialMetadataSchema,
} from '@/types/api'

type ValueType = CredentialMetadataFieldSchema['type']

export interface OptionDraft {
  value: string
  label: string
}

export interface FieldDraft {
  locked: boolean
  key: string
  title: string
  description: string
  type: ValueType
  defaultValue: string
  options: OptionDraft[]
  css: string
  expanded?: boolean
}

// 快速 CSS 预设集
const CSS_PRESETS = [
  {
    name: '琥珀高亮',
    css: 'color: #b45309; background-color: #fffbeb; border-color: #fde68a; font-weight: 600;',
  },
  {
    name: '翡翠绿',
    css: 'color: #047857; background-color: #ecfdf5; border-color: #a7f3d0; font-weight: 600;',
  },
  {
    name: '玫瑰红',
    css: 'color: #b91c1c; background-color: #fef2f2; border-color: #fecaca; font-weight: 600;',
  },
  {
    name: '紫罗兰',
    css: 'color: #6d28d9; background-color: #f5f3ff; border-color: #ddd6fe; font-weight: 600;',
  },
  {
    name: '中性灰',
    css: 'color: #374151; background-color: #f3f4f6; border-color: #e5e7eb;',
  },
]

// 系统默认的基础字段模板 (type, saleStatus, salePrice)
const DEFAULT_BUILTIN_PROPERTIES: Record<string, CredentialMetadataFieldSchema> = {
  type: {
    title: '账号类型',
    description: '账号运营分类，仅用于标记，不参与调度。',
    type: 'string',
    default: 'normal',
    oneOf: [
      { const: 'normal', title: '正常号' },
      { const: 'boom', title: '炸弹号' },
    ],
    'x-css': 'color: #b45309; background-color: #fffbeb; border-color: #fde68a;',
  },
  saleStatus: {
    title: '在售状态',
    description: '账号运营销售状态，仅用于标记，不参与调度。',
    type: 'string',
    default: 'not_for_sale',
    oneOf: [
      { const: 'not_for_sale', title: '非卖品' },
      { const: 'for_sale', title: '在售' },
      { const: 'sold', title: '已售' },
    ],
    'x-css': 'color: #047857; background-color: #ecfdf5; border-color: #a7f3d0;',
  },
  salePrice: {
    title: '销售价格（CNY）',
    description: '账号销售价格，单位为人民币；未设置时不在卡片显示。',
    type: 'number',
    minimum: 0,
    'x-css': 'color: #0284c7; background-color: #f0f9ff; border-color: #bae6fd;',
  },
}

function schemaToDrafts(schema: CredentialMetadataSchema): FieldDraft[] {
  const mergedProperties = {
    ...DEFAULT_BUILTIN_PROPERTIES,
    ...(schema?.properties ?? {}),
  }
  return Object.entries(mergedProperties).map(([key, field]) => ({
    locked: ['type', 'saleStatus', 'salePrice'].includes(key),
    key,
    title: field.title,
    description: field.description ?? '',
    type: field.type,
    defaultValue: field.default == null ? '' : String(field.default),
    options:
      field.oneOf?.map((option) => ({
        value: String(option.const),
        label: option.title,
      })) ?? [],
    css: field['x-css'] ?? '',
    expanded: true,
  }))
}

function parseDefault(value: string, type: ValueType): unknown {
  if (value === '') return undefined
  if (type === 'boolean') return value === 'true'
  if (type === 'number' || type === 'integer') return Number(value)
  return value
}

function draftsToSchema(
  base: CredentialMetadataSchema,
  drafts: FieldDraft[],
): CredentialMetadataSchema {
  const properties: Record<string, CredentialMetadataFieldSchema> = {}
  for (const draft of drafts) {
    const field: CredentialMetadataFieldSchema = {
      title: draft.title.trim() || draft.key,
      type: draft.type,
    }
    if (draft.description.trim()) field.description = draft.description.trim()
    const defaultValue = parseDefault(draft.defaultValue.trim(), draft.type)
    if (defaultValue !== undefined) field.default = defaultValue

    const options = draft.options
      .filter((opt) => opt.value.trim() !== '')
      .map((opt) => {
        const raw = opt.value.trim()
        const parsed =
          draft.type === 'boolean'
            ? raw === 'true'
            : draft.type === 'number' || draft.type === 'integer'
            ? Number(raw)
            : raw
        return { const: parsed, title: opt.label.trim() || raw }
      })

    if (options.length > 0) field.oneOf = options
    if (draft.css.trim()) field['x-css'] = draft.css.trim()
    if (draft.key.trim() === 'salePrice') field.minimum = 0
    properties[draft.key.trim()] = field
  }

  // 保证 required 里始终保留存在的 type 和 saleStatus
  const required = ['type', 'saleStatus'].filter((k) =>
    Object.prototype.hasOwnProperty.call(properties, k),
  )

  return {
    ...base,
    type: 'object',
    properties,
    required,
    additionalProperties: true,
  }
}

export function MetadataSection() {
  const queryClient = useQueryClient()
  const { data, isLoading } = useCredentialMetadataSchema()
  const { mutate, isPending } = useSetCredentialMetadataSchema()
  const [drafts, setDrafts] = useState<FieldDraft[]>([])

  useEffect(() => {
    if (data?.schema) setDrafts(schemaToDrafts(data.schema))
  }, [data])

  const update = (index: number, patch: Partial<FieldDraft>) => {
    setDrafts((current) =>
      current.map((field, i) => (i === index ? { ...field, ...patch } : field)),
    )
  }

  const toggleExpand = (index: number) => {
    setDrafts((current) =>
      current.map((field, i) =>
        i === index ? { ...field, expanded: !field.expanded } : field,
      ),
    )
  }

  const moveField = (index: number, direction: 'up' | 'down') => {
    setDrafts((current) => {
      const targetIndex = direction === 'up' ? index - 1 : index + 1
      if (targetIndex < 0 || targetIndex >= current.length) return current
      const next = [...current]
      const temp = next[index]
      next[index] = next[targetIndex]
      next[targetIndex] = temp
      return next
    })
  }

  const addField = () => {
    setDrafts((current) => [
      ...current,
      {
        locked: false,
        key: '',
        title: '',
        description: '',
        type: 'string',
        defaultValue: '',
        options: [],
        css: '',
        expanded: true,
      },
    ])
  }

  const addOption = (fieldIndex: number) => {
    const field = drafts[fieldIndex]
    const nextOptions = [...field.options, { value: '', label: '' }]
    update(fieldIndex, { options: nextOptions })
  }

  const updateOption = (
    fieldIndex: number,
    optionIndex: number,
    patch: Partial<OptionDraft>,
  ) => {
    const field = drafts[fieldIndex]
    const nextOptions = field.options.map((opt, i) =>
      i === optionIndex ? { ...opt, ...patch } : opt,
    )
    update(fieldIndex, { options: nextOptions })
  }

  const removeOption = (fieldIndex: number, optionIndex: number) => {
    const field = drafts[fieldIndex]
    const nextOptions = field.options.filter((_, i) => i !== optionIndex)
    update(fieldIndex, { options: nextOptions })
  }

  const save = () => {
    if (!data?.schema) return
    const keys = drafts.map((field) => field.key.trim())
    if (keys.some((key) => !key)) {
      toast.error('字段 key 不能为空')
      return
    }
    if (new Set(keys).size !== keys.length) {
      toast.error('字段 key 不能重复')
      return
    }
    for (const field of drafts) {
      const defaultValue = field.defaultValue.trim()
      if (
        defaultValue &&
        field.type === 'boolean' &&
        !['true', 'false'].includes(defaultValue)
      ) {
        toast.error(`${field.key} 的布尔默认值只能是 true 或 false`)
        return
      }
      if (
        defaultValue &&
        (field.type === 'number' || field.type === 'integer') &&
        (!Number.isFinite(Number(defaultValue)) ||
          (field.type === 'integer' && !Number.isInteger(Number(defaultValue))))
      ) {
        toast.error(`${field.key} 的默认值类型不正确`)
        return
      }
      const cssError = validateMetadataCss(field.css)
      if (cssError) {
        toast.error(`${field.key}: ${cssError}`)
        return
      }
    }
    mutate(
      { schema: draftsToSchema(data.schema, drafts) },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ['credentials'] })
          queryClient.invalidateQueries({ queryKey: ['credential-metadata-schema'] })
          toast.success('凭据 Metadata Schema 已保存（已被实时保存至配置文件）')
        },
        onError: (error) =>
          toast.error(`保存失败: ${extractErrorMessage(error)}`),
      },
    )
  }

  return (
    <SettingGroup
      title="凭据 Metadata Schema"
      description="自定义凭据属性结构。全量开放编辑字段 Key、标题、类型、枚举值、默认值、CSS 胶囊样式与卡片展示顺序。"
    >
      <div className="space-y-4 py-2">
        {drafts.map((field, index) => {
          const builtIn = field.locked
          const isExpanded = field.expanded ?? true
          const parsedStyle = metadataCssToStyle(field.css)

          return (
            <div
              key={`field-${field.key || index}`}
              className="rounded-2xl border border-border/80 bg-card shadow-apple-sm hover:shadow-apple transition-all"
            >
              {/* 卡片 Header: Key、Title、类型 Badge、排序与操作 */}
              <div className="flex flex-wrap items-center justify-between gap-2 p-3 sm:px-4">
                <div className="flex min-w-0 flex-1 items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => toggleExpand(index)}
                    className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    title={isExpanded ? '折叠详情' : '展开详情'}
                  >
                    <ChevronRight
                      className={`h-4 w-4 transition-transform duration-200 ${
                        isExpanded ? 'rotate-90' : ''
                      }`}
                    />
                  </button>

                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-semibold text-foreground">
                      {field.key || <span className="text-muted-foreground italic">未命名 key</span>}
                    </span>

                    {field.title && (
                      <span className="text-xs text-muted-foreground">
                        ({field.title})
                      </span>
                    )}

                    <Badge variant="outline" className="text-[10px] uppercase font-mono">
                      {field.type}
                    </Badge>

                    {builtIn && (
                      <Badge
                        variant="secondary"
                        className="bg-primary/10 text-primary border-primary/20 text-[10px]"
                      >
                        系统默认
                      </Badge>
                    )}
                  </div>
                </div>

                {/* 快捷操作区 */}
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    disabled={index === 0 || isPending}
                    onClick={() => moveField(index, 'up')}
                    title="向上移动排序"
                  >
                    <ChevronUp className="h-4 w-4" />
                  </Button>

                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    disabled={index === drafts.length - 1 || isPending}
                    onClick={() => moveField(index, 'down')}
                    title="向下移动排序"
                  >
                    <ChevronDown className="h-4 w-4" />
                  </Button>

                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    disabled={isPending}
                    onClick={() =>
                      setDrafts((current) => current.filter((_, i) => i !== index))
                    }
                    className="h-8 w-8 text-destructive/80 hover:text-destructive hover:bg-destructive/10"
                    title="删除字段"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {/* 展开的完整编辑面板 */}
              {isExpanded && (
                <div className="space-y-4 border-t border-border/40 p-3 sm:p-4 bg-muted/5">
                  {/* 核心三元组：Key, Title, Type */}
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="space-y-1">
                      <label className="text-[11px] font-semibold text-muted-foreground uppercase">
                        字段 Key
                      </label>
                      <Input
                        value={field.key}
                        onChange={(event) =>
                          update(index, { key: event.target.value })
                        }
                        placeholder="例如: salePrice"
                        disabled={isPending}
                        className="font-mono text-sm"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-[11px] font-semibold text-muted-foreground uppercase">
                        显示名称 (Title)
                      </label>
                      <Input
                        value={field.title}
                        onChange={(event) =>
                          update(index, { title: event.target.value })
                        }
                        placeholder="例如: 售卖价格"
                        disabled={isPending}
                        className="text-sm"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-[11px] font-semibold text-muted-foreground uppercase">
                        数据类型 (Type)
                      </label>
                      <Select
                        value={field.type}
                        onValueChange={(value) =>
                          update(index, { type: value as ValueType })
                        }
                        disabled={isPending}
                      >
                        <SelectTrigger className="text-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="string">字符串 (String)</SelectItem>
                          <SelectItem value="number">数字 (Number)</SelectItem>
                          <SelectItem value="integer">整数 (Integer)</SelectItem>
                          <SelectItem value="boolean">布尔值 (Boolean)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* 字段描述 & 默认值 */}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <label className="text-[11px] font-semibold text-muted-foreground uppercase">
                        字段说明
                      </label>
                      <Input
                        value={field.description}
                        onChange={(event) =>
                          update(index, { description: event.target.value })
                        }
                        placeholder="在编辑弹窗和提示中展示的说明"
                        disabled={isPending}
                        className="text-sm"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-[11px] font-semibold text-muted-foreground uppercase">
                        默认值
                      </label>
                      <Input
                        value={field.defaultValue}
                        onChange={(event) =>
                          update(index, { defaultValue: event.target.value })
                        }
                        placeholder={
                          field.type === 'boolean'
                            ? 'true 或 false'
                            : '可选，新建凭据时的初始值'
                        }
                        disabled={isPending}
                        className="font-mono text-sm"
                      />
                    </div>
                  </div>

                  {/* 可视化枚举选项 (Options Visual Editor) */}
                  <div className="space-y-2 rounded-xl border border-border/50 bg-background/60 p-3">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground uppercase">
                        <Sliders className="h-3.5 w-3.5 text-primary" />
                        枚举选项 (OneOf Options)
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs text-primary"
                        onClick={() => addOption(index)}
                        disabled={isPending}
                      >
                        <Plus className="mr-1 h-3.5 w-3.5" />
                        添加选项
                      </Button>
                    </div>

                    {field.options.length > 0 ? (
                      <div className="space-y-2 pt-1">
                        {field.options.map((opt, optIdx) => (
                          <div
                            key={`opt-${optIdx}`}
                            className="flex items-center gap-2"
                          >
                            <Input
                              value={opt.value}
                              onChange={(e) =>
                                updateOption(index, optIdx, {
                                  value: e.target.value,
                                })
                              }
                              placeholder="存储值 (const)"
                              disabled={isPending}
                              className="h-8 font-mono text-xs flex-1"
                            />
                            <span className="text-muted-foreground/60 text-xs">:</span>
                            <Input
                              value={opt.label}
                              onChange={(e) =>
                                updateOption(index, optIdx, {
                                  label: e.target.value,
                                })
                              }
                              placeholder="显示名称 (label)"
                              disabled={isPending}
                              className="h-8 text-xs flex-1"
                            />
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8 text-muted-foreground hover:text-destructive"
                              disabled={isPending}
                              onClick={() => removeOption(index, optIdx)}
                              title="删除选项"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[11px] text-muted-foreground/70 italic py-1">
                        暂未配置枚举选项（任意输入格式）。
                      </p>
                    )}
                  </div>

                  {/* 样式控制 & 实时预览 (Live CSS Preview) */}
                  <div className="space-y-2 rounded-xl border border-border/50 bg-background/60 p-3">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <span className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground uppercase">
                        <Palette className="h-3.5 w-3.5 text-primary" />
                        样式与卡片实时渲染预览 (Live Preview)
                      </span>
                      {/* 快捷 Preset 按钮组 */}
                      <div className="flex items-center gap-1 flex-wrap">
                        <span className="text-[10px] text-muted-foreground mr-1">
                          快捷配色:
                        </span>
                        {CSS_PRESETS.map((preset) => (
                          <button
                            key={preset.name}
                            type="button"
                            onClick={() => update(index, { css: preset.css })}
                            disabled={isPending}
                            className="rounded px-1.5 py-0.5 text-[10px] border border-border/60 bg-muted/40 hover:bg-accent hover:text-primary transition-colors"
                          >
                            {preset.name}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-[1fr_auto] items-center pt-1">
                      <Input
                        value={field.css}
                        onChange={(event) =>
                          update(index, { css: event.target.value })
                        }
                        placeholder="例如: color: #b45309; background-color: #fffbeb; font-weight: 600;"
                        disabled={isPending}
                        className="font-mono text-xs"
                      />

                      {/* 实时胶囊预览 */}
                      <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-card p-2">
                        <span className="text-[10px] font-semibold text-muted-foreground">
                          效果:
                        </span>
                        <span
                          className="inline-flex min-w-0 max-w-full items-center rounded-md border px-2 py-0.5 text-xs font-medium transition-all"
                          style={parsedStyle}
                        >
                          <span className="opacity-70 mr-1">
                            {field.title || field.key || '字段'}:
                          </span>
                          <span>示例值</span>
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )
        })}

        {/* 底部保存与添加控制 */}
        <div className="flex flex-wrap justify-between gap-3 pt-2 border-t border-border/40">
          <Button
            type="button"
            variant="outline"
            onClick={addField}
            disabled={isLoading || isPending}
            className="h-9 px-4 text-xs font-medium"
          >
            <Plus className="mr-1.5 h-4 w-4" />
            新增字段
          </Button>

          <Button
            type="button"
            onClick={save}
            disabled={isLoading || isPending || drafts.length === 0}
            className="h-9 px-5 text-xs font-semibold shadow-apple-sm"
          >
            <Save className="mr-1.5 h-4 w-4" />
            {isPending ? '保存中…' : '保存 Schema 配置'}
          </Button>
        </div>
      </div>
    </SettingGroup>
  )
}
