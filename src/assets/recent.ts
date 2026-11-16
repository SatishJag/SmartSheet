import type { AssetType } from './types'

/** The assets a person opened lately, newest first. Kept in this browser only (a convenience, not data). */

export interface RecentItem {
  type: AssetType
  id: string
  at: number
}

export const RECENT_LIMIT = 12
const key = (userId: string) => `smartsheet-recent:${userId}`

export function readRecent(userId: string): RecentItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key(userId)) ?? '[]') as unknown
    if (!Array.isArray(raw)) return []
    return raw
      .filter((r): r is RecentItem => !!r && typeof r === 'object' && ['sheet', 'report', 'dashboard'].includes((r as RecentItem).type) && typeof (r as RecentItem).id === 'string')
      .slice(0, RECENT_LIMIT)
  } catch {
    return []
  }
}

/** Moves (or adds) an asset to the front. Storage that is blocked or full is ignored. */
export function pushRecent(userId: string, type: AssetType, id: string, now = Date.now()): void {
  try {
    const next = [{ type, id, at: now }, ...readRecent(userId).filter((r) => !(r.type === type && r.id === id))].slice(0, RECENT_LIMIT)
    localStorage.setItem(key(userId), JSON.stringify(next))
  } catch {
    // private mode or quota: recents are optional
  }
}
