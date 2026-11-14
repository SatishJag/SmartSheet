import { createContext, useContext } from 'react'

const ShowCriticalPathContext = createContext(false)

/** Whether the views should highlight the critical path (a per-session choice made in the sheet header). */
export const ShowCriticalPathProvider = ShowCriticalPathContext.Provider
export const useShowCriticalPath = () => useContext(ShowCriticalPathContext)

/** The short float text shown beside a row: "Critical" or "3d float". */
export function floatBadge(info: { critical: boolean; totalFloat: number }): string {
  return info.critical ? 'Critical' : `${info.totalFloat}d float`
}

/** The full sentence for tooltips and screen readers. */
export function floatDescription(info: { critical: boolean; totalFloat: number; freeFloat: number }): string {
  const days = (n: number) => `${n} working ${n === 1 ? 'day' : 'days'}`
  return info.critical
    ? 'On the critical path: no float'
    : `Total float ${days(info.totalFloat)}, free float ${days(info.freeFloat)}`
}
