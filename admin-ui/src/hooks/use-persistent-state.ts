import { useCallback, useState } from 'react'
import { readPref, writePref, type Revive } from '@/lib/preferences'

/**
 * 和 `useState` 用法一致，但每次更新都同步写回 localStorage。
 *
 * 刻意在 setter 里写而不是用 `useEffect` 监听：`useEffect` 会在挂载时先写一次，
 * 把默认值固化进存储，之后再改默认值就对老用户失效了。
 *
 * @param key    `PREF_KEYS` 里的键
 * @param initial 存储为空或值非法时的默认值
 * @param revive  校验器，把存储里的原始 JSON 归一化成 T
 */
export function usePersistentState<T>(
  key: string,
  initial: T,
  revive?: Revive<T>,
): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => readPref(key, initial, revive))

  const update = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved =
          typeof next === 'function' ? (next as (p: T) => T)(prev) : next
        writePref(key, resolved)
        return resolved
      })
    },
    [key],
  )

  return [value, update]
}

/**
 * `usePersistentState` 的 Set 版本：存储层是数组，使用层是 Set。
 *
 * 多选筛选（订阅分级、隐藏状态）都用 Set 做命中判断，直接存 Set 会被
 * `JSON.stringify` 变成 `{}`，所以在这一层做数组 ↔ Set 的转换。
 */
export function usePersistentSet<T extends string>(
  key: string,
  initial: Set<T>,
  revive: Revive<Set<T>>,
): [Set<T>, (next: Set<T> | ((prev: Set<T>) => Set<T>)) => void] {
  const [value, setValue] = useState<Set<T>>(() => readPref(key, initial, revive))

  const update = useCallback(
    (next: Set<T> | ((prev: Set<T>) => Set<T>)) => {
      setValue((prev) => {
        const resolved =
          typeof next === 'function'
            ? (next as (p: Set<T>) => Set<T>)(prev)
            : next
        writePref(key, [...resolved])
        return resolved
      })
    },
    [key],
  )

  return [value, update]
}
