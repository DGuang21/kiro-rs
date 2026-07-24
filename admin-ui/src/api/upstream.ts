// 补货上游（Restock Upstream）API 层 —— 对接后端 /api/admin/upstream/*。
//
// 后端持久化上游配置（upstreams.json）与事件日志（upstream_events.json）；
// 查询库存/余额、提号、注册/测试 webhook 均由后端调用真实上游 API 完成。

import axios from 'axios'
import { storage } from '@/lib/storage'

const api = axios.create({
  baseURL: '/api/admin',
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
})

api.interceptors.request.use((config) => {
  const apiKey = storage.getApiKey()
  if (apiKey) config.headers['x-api-key'] = apiKey
  return config
})

/** 单条高峰时段规则：某些星期几的 [startHour, endHour)（整点，服务器本地时间） */
export interface PeakWindow {
  /** 生效星期几，0=周日…6=周六；空数组 = 每天 */
  weekdays: number[]
  /** 起始小时 0-23（含） */
  startHour: number
  /** 结束小时 0-23（不含）；支持跨天（start > end，如 22→6） */
  endHour: number
}

/** 分时段自动提货量：多条高峰规则 + 高峰/低谷两档 */
export interface PurchaseSchedule {
  enabled: boolean
  /** 高峰时段规则（命中任一即为高峰） */
  peakWindows: PeakWindow[]
  /** 高峰提货量（0 = 提满） */
  peakCount: number
  /** 低谷提货量（0 = 提满） */
  offpeakCount: number
}

/** 上游配置（脱敏视图，后端返回；不含明文 apiKey） */
export interface UpstreamConfig {
  id: string
  name: string
  baseUrl: string
  /** 脱敏后的 apiKey（仅展示） */
  maskedApiKey: string
  /** 本服务对外可达地址（用于拼 webhook 接收地址） */
  receiverBaseUrl?: string
  /** 完整 webhook 接收地址（receiverBaseUrl + 路径 + token）；未配置 receiverBaseUrl 时为空 */
  webhookReceiverUrl?: string
  /** 是否开启自动提号 */
  autoPurchaseEnabled: boolean
  /** 自动提号数量（0 = 按 stock.max 提满） */
  autoPurchaseCount: number
  /** 分时段自动提货量（enabled 时覆盖 autoPurchaseCount） */
  schedule?: PurchaseSchedule
  /** 入库凭据使用的端点（cli / ide 等）；留空回退全局默认 */
  endpoint?: string
  /** 自动入库凭据的分组 */
  groups: string[]
  enabled: boolean
  note?: string
  createdAt: string
}

export interface UpstreamsResponse {
  total: number
  upstreams: UpstreamConfig[]
}

/** 创建 / 更新上游的请求体 */
export interface UpsertUpstreamRequest {
  name: string
  baseUrl?: string
  /** 明文 apiKey；更新时留空表示不改 */
  apiKey?: string
  receiverBaseUrl?: string | null
  autoPurchaseEnabled?: boolean
  autoPurchaseCount?: number
  schedule?: PurchaseSchedule
  endpoint?: string | null
  groups?: string[]
  enabled?: boolean
  note?: string | null
}

export interface StockResponse {
  max: number
}

export interface UpstreamProfile {
  name?: string
  quota?: number
  remaining?: number
  usedQuota?: number
  webhookUrl?: string
}

export interface PurchaseResult {
  clientOrderId: string
  purchased: number
  imported: number
}

/** GET /api/my/keys 单条 */
export interface UpstreamKeyItem {
  key: string
  status?: string
  createdAt?: string
}

export interface UpstreamKeysResponse {
  count: number
  active: number
  keys: UpstreamKeyItem[]
}

/** 账号有效期起点 */
export interface KeysCreatedAt {
  createdAt: string | null
  keyCount: number
}

/** 最近提取订单 */
export interface UpstreamOrder {
  clientOrderId?: string
  requested?: number
  purchased?: number
  createdAt?: string
}

/** 事件类型 */
export type UpstreamEventKind =
  | 'new_keys_available'
  | 'all_keys_dead'
  | 'auto_purchase'
  | 'manual_purchase'
  | 'error'

export interface UpstreamEvent {
  id: string
  upstreamId: string
  upstreamName: string
  kind: UpstreamEventKind
  message: string
  orderId?: string
  requested?: number
  imported?: number
  ok: boolean
  createdAt: string
}

export interface UpstreamEventsResponse {
  total: number
  events: UpstreamEvent[]
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export async function listUpstreams(): Promise<UpstreamConfig[]> {
  const { data } = await api.get<UpstreamsResponse>('/upstream')
  return data.upstreams
}

export async function createUpstream(req: UpsertUpstreamRequest): Promise<UpstreamConfig> {
  const { data } = await api.post<UpstreamConfig>('/upstream', req)
  return data
}

export async function updateUpstream(
  id: string,
  req: UpsertUpstreamRequest,
): Promise<UpstreamConfig> {
  const { data } = await api.put<UpstreamConfig>(`/upstream/${id}`, req)
  return data
}

export async function deleteUpstream(id: string): Promise<void> {
  await api.delete(`/upstream/${id}`)
}

// ── 动作 ─────────────────────────────────────────────────────────────────────

export async function queryUpstreamStock(id: string): Promise<StockResponse> {
  const { data } = await api.get<StockResponse>(`/upstream/${id}/stock`)
  return data
}

export async function queryUpstreamProfile(id: string): Promise<UpstreamProfile> {
  const { data } = await api.get<UpstreamProfile>(`/upstream/${id}/profile`)
  return data
}

/** GET 全部 Key（history=true 含已失效） */
export async function queryUpstreamKeys(
  id: string,
  history = false,
): Promise<UpstreamKeysResponse> {
  const { data } = await api.get<UpstreamKeysResponse>(`/upstream/${id}/keys`, {
    params: history ? { history: '1' } : undefined,
  })
  return data
}

/** 账号有效期起点（最早一条 Key 的创建时间） */
export async function queryUpstreamCreatedAt(id: string): Promise<KeysCreatedAt> {
  const { data } = await api.get<KeysCreatedAt>(`/upstream/${id}/created-at`)
  return data
}

/** 最近提取订单 */
export async function queryUpstreamOrders(id: string): Promise<UpstreamOrder[]> {
  const { data } = await api.get<{ orders: UpstreamOrder[] }>(`/upstream/${id}/orders`)
  return data.orders
}

/** 上游系统状态与库存（原样透传） */
export async function queryUpstreamStatus(id: string): Promise<Record<string, unknown>> {
  const { data } = await api.get<Record<string, unknown>>(`/upstream/${id}/status`)
  return data
}

/** 手动提号并入库。count 传 0 表示按 stock.max 提满 */
export async function purchaseUpstream(id: string, count: number): Promise<PurchaseResult> {
  const { data } = await api.post<PurchaseResult>(`/upstream/${id}/purchase`, { count })
  return data
}

export async function registerUpstreamWebhook(
  id: string,
): Promise<{ success: boolean; message: string; webhookUrl: string }> {
  const { data } = await api.post(`/upstream/${id}/webhook/register`)
  return data
}

export async function testUpstreamWebhook(
  id: string,
): Promise<{ success: boolean; message: string }> {
  const { data } = await api.post(`/upstream/${id}/webhook/test`)
  return data
}

export async function listUpstreamEvents(): Promise<UpstreamEvent[]> {
  const { data } = await api.get<UpstreamEventsResponse>('/upstream/events')
  return data.events
}
