// 补货上游（Restock Upstream）API 层。
//
// ⚠️ 目前为 Mock 实现：上游配置存 localStorage，查询余额 / 提取 KEY / Webhook
// 均返回模拟数据。等拿到真实上游 API 后，只需把下方几个 `mock*` 函数替换为
// 真正的 fetch(config.baseUrl + path, { headers: { apiKey } }) 调用即可，
// 组件与 hooks 无需改动。

const STORAGE_KEY = 'restockUpstreams'
const MOCK_STATE_KEY = 'restockUpstreamMockState'

/** 单个上游配置 */
export interface UpstreamConfig {
  id: string
  /** 展示名，如 "转售商A" */
  name: string
  /** 上游 API 基础地址，如 https://api.example.com */
  baseUrl: string
  /** 上游鉴权 API Key */
  apiKey: string
  /** 查询余额的路径（附加到 baseUrl 之后），如 /v1/balance */
  balancePath: string
  /** 提取新 KEY 的路径，如 /v1/keys/issue */
  extractPath: string
  /** Webhook 回调地址（上游 → 本服务通知） */
  webhookUrl?: string
  /** 备注 */
  note?: string
  createdAt: string
}

/** 查询余额响应 */
export interface UpstreamBalance {
  /** 账户余额（金额，单位由上游定义，Mock 用元） */
  balance: number
  /** 货币符号 / 单位 */
  currency: string
  /** 剩余可提取的 KEY 数量 */
  remainingKeys: number
  /** 单个 KEY 单价（用于估算） */
  unitPrice: number
}

/** 提取新 KEY 响应 */
export interface ExtractKeysResponse {
  keys: string[]
  /** 本次消耗金额 */
  cost: number
  /** 提取后剩余 KEY 数量 */
  remainingKeys: number
}

/** Webhook 测试响应 */
export interface WebhookTestResponse {
  ok: boolean
  message: string
  /** 往返延迟（ms） */
  latencyMs: number
}

// ── localStorage 配置读写 ────────────────────────────────────────────────────

function readConfigs(): UpstreamConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeConfigs(list: UpstreamConfig[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
}

/** 模拟网络延迟，让 Mock 更真实 */
function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── Mock 库存状态（按上游 id 记录剩余 KEY 数，提取后递减）────────────────────

interface MockState {
  [upstreamId: string]: { remainingKeys: number; balance: number }
}

function readMockState(): MockState {
  try {
    const raw = localStorage.getItem(MOCK_STATE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function writeMockState(state: MockState) {
  localStorage.setItem(MOCK_STATE_KEY, JSON.stringify(state))
}

/** 由字符串派生一个稳定的伪随机种子，保证同一上游的初始库存一致 */
function seedFromId(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0x7fffffff
  return h
}

/** 取（或初始化）某上游的 Mock 库存 */
function ensureMockEntry(id: string): { remainingKeys: number; balance: number } {
  const state = readMockState()
  if (!state[id]) {
    const seed = seedFromId(id)
    state[id] = {
      remainingKeys: 20 + (seed % 80), // 20~99 个
      balance: 100 + (seed % 900), // 100~999 元
    }
    writeMockState(state)
  }
  return state[id]
}

const MOCK_UNIT_PRICE = 5 // 元/个

// ── CRUD ─────────────────────────────────────────────────────────────────────

export async function listUpstreams(): Promise<UpstreamConfig[]> {
  await delay(120)
  return readConfigs()
}

export async function saveUpstream(config: Partial<UpstreamConfig> & { name: string }): Promise<UpstreamConfig> {
  await delay(120)
  const list = readConfigs()
  if (config.id) {
    const idx = list.findIndex((u) => u.id === config.id)
    if (idx < 0) throw new Error('上游不存在')
    list[idx] = { ...list[idx], ...config } as UpstreamConfig
    writeConfigs(list)
    return list[idx]
  }
  const created: UpstreamConfig = {
    id: `up_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: config.name,
    baseUrl: config.baseUrl ?? '',
    apiKey: config.apiKey ?? '',
    balancePath: config.balancePath ?? '/v1/balance',
    extractPath: config.extractPath ?? '/v1/keys/issue',
    webhookUrl: config.webhookUrl,
    note: config.note,
    createdAt: new Date().toISOString(),
  }
  list.push(created)
  writeConfigs(list)
  return created
}

export async function deleteUpstream(id: string): Promise<void> {
  await delay(80)
  writeConfigs(readConfigs().filter((u) => u.id !== id))
}

// ── Mock 业务 API（后续替换为真实 fetch）─────────────────────────────────────

/** 查询上游余额与剩余可提取 KEY 数量。TODO: 替换为真实 GET baseUrl+balancePath */
export async function queryUpstreamBalance(id: string): Promise<UpstreamBalance> {
  await delay(500)
  const entry = ensureMockEntry(id)
  return {
    balance: entry.balance,
    currency: '¥',
    remainingKeys: entry.remainingKeys,
    unitPrice: MOCK_UNIT_PRICE,
  }
}

/** 从上游提取 count 个新 API KEY。TODO: 替换为真实 POST baseUrl+extractPath */
export async function extractUpstreamKeys(id: string, count: number): Promise<ExtractKeysResponse> {
  await delay(900)
  const state = readMockState()
  const entry = state[id] ?? ensureMockEntry(id)
  if (count <= 0) throw new Error('数量必须大于 0')
  if (count > entry.remainingKeys) {
    throw new Error(`上游剩余不足：仅剩 ${entry.remainingKeys} 个`)
  }
  const cost = count * MOCK_UNIT_PRICE
  if (cost > entry.balance) {
    throw new Error(`余额不足：需 ${cost} 元，仅剩 ${entry.balance} 元`)
  }
  // 生成 mock KEY
  const keys = Array.from({ length: count }, () => {
    const rand = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10)
    return `ksk_mock_${rand}`
  })
  entry.remainingKeys -= count
  entry.balance -= cost
  state[id] = entry
  writeMockState(state)
  return { keys, cost, remainingKeys: entry.remainingKeys }
}

/** 测试 Webhook 连通性。TODO: 替换为真实 POST webhookUrl */
export async function testUpstreamWebhook(url: string): Promise<WebhookTestResponse> {
  await delay(600)
  if (!url.trim()) throw new Error('请先填写 Webhook 地址')
  if (!/^https?:\/\//.test(url.trim())) {
    return { ok: false, message: '地址需以 http(s):// 开头', latencyMs: 0 }
  }
  return { ok: true, message: 'Webhook 可达（Mock）', latencyMs: 40 + Math.floor(Math.random() * 120) }
}
