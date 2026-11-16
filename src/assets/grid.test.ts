import { describe, expect, it } from 'vitest'
import { newWidget } from './definition'
import { clampRect, compact, nextFreeSlot, nudge, overlaps, placeWidget, reorder, stackOrder } from './grid'
import type { Widget } from './types'

const w = (id: string, x: number, y: number, ww: number, h: number): Widget => ({ ...newWidget('text', id, x, y), w: ww, h })
const rect = (list: Widget[], id: string) => {
  const o = list.find((x) => x.id === id)!
  return [o.x, o.y, o.w, o.h]
}
const noOverlap = (list: Widget[]) => list.every((a, i) => list.every((b, j) => i === j || !overlaps(a, b)))

describe('clampRect', () => {
  it('keeps a rectangle inside the 12-column grid with at least one cell', () => {
    expect(clampRect({ x: 10, y: -3, w: 6, h: 0 })).toEqual({ x: 6, y: 0, w: 6, h: 1 })
    expect(clampRect({ x: -4, y: 2, w: 30, h: 99 })).toEqual({ x: 0, y: 2, w: 12, h: 40 })
  })
})

describe('placeWidget', () => {
  it('moves a widget into free space without touching the others', () => {
    const list = [w('a', 0, 0, 4, 2), w('b', 4, 0, 4, 2)]
    const next = placeWidget(list, 'a', { x: 8, y: 0 })
    expect(rect(next, 'a')).toEqual([8, 0, 4, 2])
    expect(rect(next, 'b')).toEqual([4, 0, 4, 2])
  })

  it('pushes the widgets it lands on down, and those below them in turn', () => {
    const list = [w('a', 0, 0, 6, 2), w('b', 0, 2, 6, 2), w('c', 6, 0, 6, 2)]
    const next = placeWidget(list, 'c', { x: 0, y: 0 })
    expect(rect(next, 'c')).toEqual([0, 0, 6, 2])
    expect(rect(next, 'a')).toEqual([0, 2, 6, 2])
    expect(rect(next, 'b')).toEqual([0, 4, 6, 2])
    expect(noOverlap(next)).toBe(true)
  })

  it('resizes, clamping to the grid, and pushes neighbours below', () => {
    const list = [w('a', 0, 0, 4, 2), w('b', 0, 2, 4, 2)]
    const next = placeWidget(list, 'a', { w: 20, h: 3 })
    expect(rect(next, 'a')).toEqual([0, 0, 12, 3])
    expect(rect(next, 'b')).toEqual([0, 3, 4, 2])
  })

  it('does not mutate its input and ignores unknown ids', () => {
    const list = [w('a', 0, 0, 4, 2)]
    const copy = JSON.stringify(list)
    placeWidget(list, 'a', { x: 5 })
    expect(JSON.stringify(list)).toBe(copy)
    expect(placeWidget(list, 'nope', { x: 5 })).toEqual(list)
  })
})

describe('nextFreeSlot', () => {
  it('fills gaps from the top left, then goes below everything', () => {
    const list = [w('a', 0, 0, 6, 2), w('b', 6, 0, 4, 2)]
    expect(nextFreeSlot(list, 2, 2)).toEqual({ x: 10, y: 0 })
    expect(nextFreeSlot(list, 4, 2)).toEqual({ x: 0, y: 2 })
    expect(nextFreeSlot([], 12, 1)).toEqual({ x: 0, y: 0 })
  })
})

describe('compact', () => {
  it('closes gaps but keeps reading order', () => {
    const list = [w('a', 0, 0, 12, 1), w('b', 0, 5, 6, 2), w('c', 6, 9, 6, 2)]
    const next = compact(list)
    expect(rect(next, 'b')).toEqual([0, 1, 6, 2])
    expect(rect(next, 'c')).toEqual([6, 1, 6, 2])
    expect(noOverlap(next)).toBe(true)
  })
})

describe('nudge', () => {
  it('moves by one cell and resizes by one cell', () => {
    const list = [w('a', 2, 2, 4, 2)]
    expect(rect(nudge(list, 'a', 'right'), 'a')).toEqual([3, 2, 4, 2])
    expect(rect(nudge(list, 'a', 'up'), 'a')).toEqual([2, 1, 4, 2])
    expect(rect(nudge(list, 'a', 'right', true), 'a')).toEqual([2, 2, 5, 2])
    expect(rect(nudge(list, 'a', 'down', true), 'a')).toEqual([2, 2, 4, 3])
  })
  it('stops at the edges', () => {
    const list = [w('a', 0, 0, 12, 1)]
    expect(rect(nudge(list, 'a', 'left'), 'a')).toEqual([0, 0, 12, 1])
    expect(rect(nudge(list, 'a', 'right', true), 'a')).toEqual([0, 0, 12, 1])
    expect(rect(nudge(list, 'a', 'up'), 'a')).toEqual([0, 0, 12, 1])
  })
})

describe('reorder', () => {
  it('swaps a widget with the one before or after it in reading order, also when they sit side by side', () => {
    const list = [w('a', 0, 0, 4, 2), w('b', 4, 0, 4, 2), w('c', 0, 2, 12, 1)]
    const up = reorder(list, 'b', 'up')
    expect(stackOrder(up).map((o) => o.id)).toEqual(['b', 'a', 'c'])
    expect(rect(up, 'b')).toEqual([0, 0, 4, 2])
    expect(rect(up, 'a')).toEqual([4, 0, 4, 2])
    expect(stackOrder(reorder(list, 'a', 'down')).map((o) => o.id)).toEqual(['b', 'a', 'c'])
    expect(noOverlap(up)).toBe(true)
  })

  it('keeps widgets of different sizes apart and does nothing at the ends', () => {
    const list = [w('a', 0, 0, 12, 1), w('b', 0, 1, 6, 3)]
    const next = reorder(list, 'b', 'up')
    expect(stackOrder(next).map((o) => o.id)).toEqual(['b', 'a'])
    expect(noOverlap(next)).toBe(true)
    expect(reorder(list, 'a', 'up')).toEqual(list)
    expect(reorder(list, 'b', 'down')).toEqual(list)
    expect(reorder(list, 'zzz', 'down')).toEqual(list)
  })
})

describe('stackOrder', () => {
  it('is reading order (what a phone shows)', () => {
    const list = [w('c', 6, 1, 3, 1), w('a', 6, 0, 3, 1), w('b', 0, 0, 3, 1)]
    expect(stackOrder(list).map((o) => o.id)).toEqual(['b', 'a', 'c'])
  })
})
