import { GRID_COLUMNS, type Widget } from './types'

/**
 * Dashboard grid arithmetic: widgets sit on a 12-column grid at (x, y) with a size of (w, h) cells.
 * Pure functions, so drag, resize and the keyboard moves share one tested set of rules: a widget never
 * leaves the grid, and widgets never overlap (a widget dropped onto others pushes them down).
 */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const MAX_ROWS = 400
export const MAX_HEIGHT = 40

export const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** Keeps a rectangle inside the grid with a size of at least 1 x 1. */
export function clampRect(r: Rect): Rect {
  const w = clamp(Math.round(r.w), 1, GRID_COLUMNS)
  const h = clamp(Math.round(r.h), 1, MAX_HEIGHT)
  return { w, h, x: clamp(Math.round(r.x), 0, GRID_COLUMNS - w), y: clamp(Math.round(r.y), 0, MAX_ROWS) }
}

/** Reading order, which is also the order a phone stacks the widgets in. */
export const stackOrder = <T extends Rect>(widgets: readonly T[]): T[] => [...widgets].sort((a, b) => a.y - b.y || a.x - b.x)

/** Pushes widgets down until none overlap; `anchorId` (the one just moved) never moves. */
export function resolveOverlaps(widgets: readonly Widget[], anchorId: string | null): Widget[] {
  const list = widgets.map((w) => ({ ...w }))
  for (let pass = 0; pass < 2000; pass++) {
    list.sort((a, b) => a.y - b.y || (a.id === anchorId ? -1 : b.id === anchorId ? 1 : a.x - b.x))
    let moved = false
    for (let i = 0; i < list.length && !moved; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (!overlaps(list[i], list[j])) continue
        const [keep, push] = list[j].id === anchorId ? [list[j], list[i]] : [list[i], list[j]]
        push.y = keep.y + keep.h
        moved = true
        break
      }
    }
    if (!moved) break
  }
  return list
}

/** Moves and / or resizes one widget, pushing the others out of its way. Unknown ids change nothing. */
export function placeWidget(widgets: readonly Widget[], id: string, patch: Partial<Rect>): Widget[] {
  const current = widgets.find((w) => w.id === id)
  if (!current) return [...widgets]
  const rect = clampRect({ x: current.x, y: current.y, w: current.w, h: current.h, ...patch })
  const next = widgets.map((w) => (w.id === id ? { ...w, ...rect } : w))
  return resolveOverlaps(next, id)
}

/** The first free spot of size w x h, scanning rows from the top; below everything when none fits. */
export function nextFreeSlot(widgets: readonly Widget[], w: number, h: number): { x: number; y: number } {
  const size = clampRect({ x: 0, y: 0, w, h })
  const bottom = widgets.reduce((m, o) => Math.max(m, o.y + o.h), 0)
  for (let y = 0; y <= bottom; y++) {
    for (let x = 0; x + size.w <= GRID_COLUMNS; x++) {
      if (!widgets.some((o) => overlaps({ x, y, w: size.w, h: size.h }, o))) return { x, y }
    }
  }
  return { x: 0, y: bottom }
}

/** Moves every widget as far up as it can go, keeping reading order: closes the gaps after deletions. */
export function compact(widgets: readonly Widget[]): Widget[] {
  const placed: Widget[] = []
  for (const w of stackOrder(widgets)) {
    let y = w.y
    while (y > 0 && !placed.some((o) => overlaps({ ...w, y: y - 1 }, o))) y--
    placed.push({ ...w, y })
  }
  const byId = new Map(placed.map((w) => [w.id, w]))
  return widgets.map((w) => byId.get(w.id)!)
}

/**
 * One step in reading order (the order a phone stacks the widgets in): the widget swaps places with its
 * neighbour before (up) or after (down) it. Works for widgets side by side, where moving up a row
 * would do nothing. Others are pushed down only if the swap makes them overlap.
 */
export function reorder(widgets: readonly Widget[], id: string, dir: 'up' | 'down'): Widget[] {
  const order = stackOrder(widgets)
  const i = order.findIndex((w) => w.id === id)
  const j = i + (dir === 'up' ? -1 : 1)
  if (i === -1 || j < 0 || j >= order.length) return [...widgets]
  const [a, b] = [order[i], order[j]]
  const at = (w: Widget, from: Widget): Widget => ({ ...w, x: Math.min(from.x, GRID_COLUMNS - w.w), y: from.y })
  const swapped = new Map([[a.id, at(a, b)], [b.id, at(b, a)]])
  return resolveOverlaps(widgets.map((w) => swapped.get(w.id) ?? w), id)
}

export type MoveDirection = 'left' | 'right' | 'up' | 'down'

/** One keyboard step: a move by one cell, or (resize = true) one cell wider / narrower / taller / shorter. */
export function nudge(widgets: readonly Widget[], id: string, dir: MoveDirection, resize = false): Widget[] {
  const w = widgets.find((o) => o.id === id)
  if (!w) return [...widgets]
  const dx = dir === 'left' ? -1 : dir === 'right' ? 1 : 0
  const dy = dir === 'up' ? -1 : dir === 'down' ? 1 : 0
  return resize ? placeWidget(widgets, id, { w: w.w + dx, h: w.h + dy }) : placeWidget(widgets, id, { x: w.x + dx, y: w.y + dy })
}
