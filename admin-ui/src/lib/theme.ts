import { PREF_KEYS, readPref, reviveOneOf, writePref } from '@/lib/preferences'

/**
 * 主题模式。`system` 跟随操作系统的 `prefers-color-scheme`，是首次访问的默认值。
 * 用户手动点过切换按钮后固定为 `light` / `dark`，不再随系统变化。
 */
export type ThemeMode = 'light' | 'dark' | 'system'

const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system']
const reviveThemeMode = reviveOneOf(THEME_MODES)

export function getThemeMode(): ThemeMode {
  return readPref<ThemeMode>(PREF_KEYS.theme, 'system', reviveThemeMode)
}

export function setThemeMode(mode: ThemeMode) {
  writePref(PREF_KEYS.theme, mode)
  applyTheme(mode)
}

/** 系统偏好；不支持 matchMedia 的环境按浅色处理 */
export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') return systemPrefersDark() ? 'dark' : 'light'
  return mode
}

/** 把主题写到 `<html>` 上：`.dark` 驱动 CSS 变量，`color-scheme` 驱动原生控件配色 */
export function applyTheme(mode: ThemeMode) {
  if (typeof document === 'undefined') return
  const resolved = resolveTheme(mode)
  const root = document.documentElement
  root.classList.toggle('dark', resolved === 'dark')
  root.style.colorScheme = resolved
}

/**
 * 在 React 挂载前调用一次，避免首帧用浅色渲染、随后再跳到深色（白闪）。
 */
export function initTheme() {
  applyTheme(getThemeMode())
}

/**
 * 订阅系统主题变化。仅在当前模式为 `system` 时才需要跟随，
 * 回调由调用方决定做什么（通常是重新 apply 并刷新 React 状态）。
 */
export function watchSystemTheme(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {}
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}
