import { useEffect, useState } from 'react'
import { Plus, Save, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingGroup } from '@/components/console/setting-row'
import {
  useCredentialMetadataSchema,
  useSetCredentialMetadataSchema,
} from '@/hooks/use-credentials'
import { extractErrorMessage } from '@/lib/utils'
import type {
  CredentialMetadataFieldSchema,
  CredentialMetadataSchema,
} from '@/types/api'

type ValueType = CredentialMetadataFieldSchema['type']

interface FieldDraft {
  locked: boolean
  key: string
  title: string
  description: string
  type: ValueType
  defaultValue: string
  options: string
}

function schemaToDrafts(schema: CredentialMetadataSchema): FieldDraft[] {
  return Object.entries(schema.properties).map(([key, field]) => ({
    locked: key === 'type',
    key,
    title: field.title,
    description: field.description ?? '',
    type: field.type,
    defaultValue: field.default == null ? '' : String(field.default),
    options: field.oneOf?.map((option) => `${String(option.const)}:${option.title}`).join(', ') ?? '',
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
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const [value, ...labelParts] = item.split(':')
        const raw = value.trim()
        const parsed = draft.type === 'boolean'
          ? raw === 'true'
          : draft.type === 'number' || draft.type === 'integer'
            ? Number(raw)
            : raw
        return { const: parsed, title: labelParts.join(':').trim() || raw }
      })
    if (options.length > 0) field.oneOf = options
    properties[draft.key.trim()] = field
  }
  return {
    ...base,
    type: 'object',
    properties,
    required: ['type'],
    additionalProperties: true,
  }
}

export function MetadataSection() {
  const { data, isLoading } = useCredentialMetadataSchema()
  const { mutate, isPending } = useSetCredentialMetadataSchema()
  const [drafts, setDrafts] = useState<FieldDraft[]>([])

  useEffect(() => {
    if (data?.schema) setDrafts(schemaToDrafts(data.schema))
  }, [data])

  const update = (index: number, patch: Partial<FieldDraft>) => {
    setDrafts((current) => current.map((field, i) => (i === index ? { ...field, ...patch } : field)))
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
        options: '',
      },
    ])
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
    const typeField = drafts.find((field) => field.key === 'type')
    if (!typeField) {
      toast.error('内置 type 字段不能删除')
      return
    }
    for (const field of drafts) {
      const defaultValue = field.defaultValue.trim()
      if (defaultValue && field.type === 'boolean' && !['true', 'false'].includes(defaultValue)) {
        toast.error(`${field.key} 的布尔默认值只能是 true 或 false`)
        return
      }
      if (
        defaultValue
        && (field.type === 'number' || field.type === 'integer')
        && (!Number.isFinite(Number(defaultValue))
          || (field.type === 'integer' && !Number.isInteger(Number(defaultValue))))
      ) {
        toast.error(`${field.key} 的默认值类型不正确`)
        return
      }
    }
    mutate(
      { schema: draftsToSchema(data.schema, drafts) },
      {
        onSuccess: () => toast.success('凭据 metadata schema 已保存'),
        onError: (error) => toast.error(`保存失败: ${extractErrorMessage(error)}`),
      },
    )
  }

  return (
    <SettingGroup
      title="凭据 Metadata Schema"
      description="定义凭据 metadata 的字段 key、值类型、默认值和枚举 value。type 是内置必填字段。"
    >
      <div className="space-y-3 py-2">
        {drafts.map((field, index) => {
          const builtIn = field.locked
          return (
            <div key={`${builtIn ? 'builtin' : 'field'}-${index}`} className="space-y-3 rounded-xl border border-border/60 p-3">
              <div className="grid gap-2 sm:grid-cols-[1fr_1fr_140px_auto]">
                <Input
                  value={field.key}
                  onChange={(event) => update(index, { key: event.target.value })}
                  placeholder="字段 key"
                  disabled={builtIn || isPending}
                  className="font-mono"
                />
                <Input
                  value={field.title}
                  onChange={(event) => update(index, { title: event.target.value })}
                  placeholder="显示名称"
                  disabled={isPending}
                />
                <Select
                  value={field.type}
                  onValueChange={(value) => update(index, { type: value as ValueType })}
                  disabled={builtIn || isPending}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="string">字符串</SelectItem>
                    <SelectItem value="number">数字</SelectItem>
                    <SelectItem value="integer">整数</SelectItem>
                    <SelectItem value="boolean">布尔值</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  disabled={builtIn || isPending}
                  onClick={() => setDrafts((current) => current.filter((_, i) => i !== index))}
                  title={builtIn ? '内置字段不能删除' : '删除字段'}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <Input
                value={field.description}
                onChange={(event) => update(index, { description: event.target.value })}
                placeholder="字段说明"
                disabled={isPending}
              />
              <div className="grid gap-2 sm:grid-cols-2">
                <Input
                  value={field.defaultValue}
                  onChange={(event) => update(index, { defaultValue: event.target.value })}
                  placeholder="默认值（可选）"
                  disabled={builtIn || isPending}
                />
                <Input
                  value={field.options}
                  onChange={(event) => update(index, { options: event.target.value })}
                  placeholder="枚举：value:名称, value:名称"
                  disabled={builtIn || isPending}
                  className="font-mono text-xs"
                />
              </div>
            </div>
          )
        })}

        <div className="flex flex-wrap justify-between gap-2">
          <Button type="button" variant="outline" onClick={addField} disabled={isLoading || isPending}>
            <Plus className="mr-1.5 h-4 w-4" />新增字段
          </Button>
          <Button type="button" onClick={save} disabled={isLoading || isPending || drafts.length === 0}>
            <Save className="mr-1.5 h-4 w-4" />{isPending ? '保存中…' : '保存 Schema'}
          </Button>
        </div>
      </div>
    </SettingGroup>
  )
}
