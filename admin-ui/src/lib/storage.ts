import {
  DEFAULT_THEME_SELECTION,
  THEME_STORAGE_KEY,
  parseThemeSelection,
  type ThemeSelection,
} from './theme'

const API_KEY_STORAGE_KEY = 'adminApiKey'

/** 凭据列表的展示形态 */
export type CredentialView = 'card' | 'list'

/**
 * 业务凭证存储。
 *
 * 界面偏好（主题、筛选、每页数量…）不放这里，统一走 `lib/preferences.ts`。
 */
export const storage = {
  getApiKey: () => (typeof localStorage === 'undefined' ? null : localStorage.getItem(API_KEY_STORAGE_KEY)),
  setApiKey: (key: string) => localStorage.setItem(API_KEY_STORAGE_KEY, key),
  removeApiKey: () => localStorage.removeItem(API_KEY_STORAGE_KEY),
}
