import { describe, expect, it, vi } from 'vitest'
import { fetchAllPages, PAGE_SIZE } from './paging'

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${String(i).padStart(5, '0')}` }))

/** A page function over a fixed array, recording the ranges asked for. */
function pager(all: { id: string }[]) {
  const ranges: [number, number][] = []
  const page = vi.fn(async (from: number, to: number) => {
    ranges.push([from, to])
    return { data: all.slice(from, Math.min(to + 1, from + PAGE_SIZE)), error: null }
  })
  return { page, ranges }
}

describe('fetchAllPages', () => {
  it('uses pages of 1000', () => {
    expect(PAGE_SIZE).toBe(1000)
  })

  it.each([
    [0, [[0, 999]]],
    [999, [[0, 999]]],
    [1000, [[0, 999], [1000, 1999]]],
    [1001, [[0, 999], [1000, 1999]]],
    [2000, [[0, 999], [1000, 1999], [2000, 2999]]],
  ])('loads all %i rows, stopping at the first short page', async (n, expected) => {
    const all = rows(n)
    const { page, ranges } = pager(all)
    expect(await fetchAllPages(page)).toEqual(all)
    expect(ranges).toEqual(expected)
  })

  it('fails loudly when a later page fails', async () => {
    const all = rows(1500)
    const page = vi.fn(async (from: number, to: number) =>
      from === 0 ? { data: all.slice(from, to + 1), error: null } : { data: null, error: { message: 'timeout' } },
    )
    await expect(fetchAllPages(page)).rejects.toThrow('timeout')
  })

  it('fails loudly when pages repeat rows (unstable order)', async () => {
    const all = rows(1000)
    const page = vi.fn(async () => ({ data: all, error: null }))
    await expect(fetchAllPages(page)).rejects.toThrow(/repeated/)
  })

  it('fails loudly when a page returns more rows than asked for', async () => {
    const page = vi.fn(async () => ({ data: rows(1001), error: null }))
    await expect(fetchAllPages(page)).rejects.toThrow(/more rows/)
  })

  it('treats null data as an empty page', async () => {
    expect(await fetchAllPages(async () => ({ data: null, error: null }))).toEqual([])
  })
})
