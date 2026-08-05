/**
 * 前端本地偏好（localStorage）的统一读写层。
 *
 * 所有“记住我的选择”类 UI 状态（主题、筛选、排序、每页数量…）都走这里：统一加
 * `kiro.ui.` 前缀、统一用 JSON 存储，避免和 API Key 这类业务键混在一个命名空间。
 *
 * 读取一律带校验。localStorage 里的值可能来自旧版本、也可能被手工改坏，非法值
 * 直接回落到默认值，而不是把 undefined 漏给页面。
 */

const PREFIX = 'kiro.ui.'

export const PREF_KEYS = {
  theme: 'theme',

  credentialGroup: 'credentials.group',
  credentialHiddenStatuses: 'credentials.hiddenStatuses',
  credentialPageSize: 'credentials.pageSize',
  credentialSearch: 'credentials.search',
  credentialSortDir: 'credentials.sortDir',
  credentialSortField: 'credentials.sortField',
  credentialTiers: 'credentials.tiers',
  credentialView: 'credentials.view',

  overviewGroupFilter: 'overview.groupFilter',
  overviewKeyFilter: 'overview.keyFilter',
  overviewTime: 'overview.time',

  traceErrorType: 'traces.errorType',
  traceGroup: 'traces.group',
  traceKeyId: 'traces.keyId',
  traceOnlyFailed: 'traces.onlyFailed',
  traceStatus: 'traces.status',
} as const

/** 校验并归一化 localStorage 里的原始值；返回 undefined 表示非法、应回落默认值 */
export type Revive<T> = (raw: unknown) => T | undefined

/**
 * 旧版本把这两项直接写在根命名空间，这里一次性搬到带前缀的新键，
 * 保证老用户升级后不会丢掉已选的展示形态和每页数量。
 */
const LEGACY_MIGRATIONS: { from: string; to: string; map: (raw: string) => unknown }[] = [
  { from: 'credentialView', to: PREF_KEYS.credentialView, map: (raw) => raw },
  { from: 'credentialPageSize', to: PREF_KEYS.credentialPageSize, map: Number },
]

function migrateLegacyKeys() {
  if (typeof localStorage === 'undefined') return
  for (const { from, to, map } of LEGACY_MIGRATIONS) {
    try {
      const raw = localStorage.getItem(from)
      if (raw === null) continue
      if (localStorage.getItem(PREFIX + to) === null) {
        localStorage.setItem(PREFIX + to, JSON.stringify(map(raw)))
      }
      localStorage.removeItem(from)
    } catch {
      // 隐私模式下 localStorage 可能直接抛异常，迁移失败就当没存过
    }
  }
}

migrateLegacyKeys()

export function readPref<T>(key: string, fallback: T, revive?: Revive<T>): T {
  if (typeof localStorage === 'undefined') return fallback
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (raw === null) return fallback
    const parsed: unknown = JSON.parse(raw)
    if (!revive) return parsed as T
    const value = revive(parsed)
    return value === undefined ? fallback : value
  } catch {
    return fallback
  }
}

export function writePref(key: string, value: unknown) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    // 超出配额 / 隐私模式：偏好写不进去不影响主流程，静默忽略
  }
}

export function removePref(key: string) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(PREFIX + key)
  } catch {
    // 同 writePref
  }
}

// ── 常用校验器 ───────────────────────────────────────────────────────────

export const reviveString: Revive<string> = (raw) =>
  typeof raw === 'string' ? raw : undefined

export const reviveBoolean: Revive<boolean> = (raw) =>
  typeof raw === 'boolean' ? raw : undefined

/** 只接受枚举内的字面量，用于排序字段、主题模式这类固定取值 */
export function reviveOneOf<T extends string>(allowed: readonly T[]): Revive<T> {
  return (raw) => (typeof raw === 'string' && (allowed as readonly string[]).includes(raw) ? (raw as T) : undefined)
}

/** 多选筛选：存成数组、用成 Set，逐项过滤掉已不存在的枚举值 */
export function reviveStringSet<T extends string>(allowed: readonly T[]): Revive<Set<T>> {
  return (raw) => {
    if (!Array.isArray(raw)) return undefined
    const valid = raw.filter((x): x is T => typeof x === 'string' && (allowed as readonly string[]).includes(x))
    return new Set(valid)
  }
}

export const reviveNonNegativeInt: Revive<number> = (raw) =>
  typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : undefined
