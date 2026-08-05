import { useCallback, useEffect, useState } from 'react'
import {
  applyTheme,
  getThemeMode,
  resolveTheme,
  setThemeMode,
  watchSystemTheme,
  type ThemeMode,
} from '@/lib/theme'

/**
 * 主题状态。初始值直接读 localStorage，切换时立刻写回，刷新后保持。
 *
 * 返回 `isDark` 是给图标用的“解析后”的结果：`system` 模式下它取决于系统偏好，
 * 所以不能直接拿 mode 判断。
 */
export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(getThemeMode)
  const [isDark, setIsDark] = useState(() => resolveTheme(getThemeMode()) === 'dark')

  // 跟随系统：仅 system 模式下需要重算，其余模式忽略系统变化
  useEffect(() => {
    if (mode !== 'system') return
    return watchSystemTheme(() => {
      applyTheme('system')
      setIsDark(resolveTheme('system') === 'dark')
    })
  }, [mode])

  const changeMode = useCallback((next: ThemeMode) => {
    setThemeMode(next)
    setMode(next)
    setIsDark(resolveTheme(next) === 'dark')
  }, [])

  // 从当前“看到的”主题取反，system 模式下点一次即固定为显式的另一侧
  const toggle = useCallback(() => {
    changeMode(resolveTheme(getThemeMode()) === 'dark' ? 'light' : 'dark')
  }, [changeMode])

  return { isDark, mode, setMode: changeMode, toggle }
}
