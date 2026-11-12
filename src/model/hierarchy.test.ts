import { describe, expect, it } from 'vitest'
import {
  deleteWithChildren,
  fullOrder,
  indent,
  moveRow,
  outdent,
  positionForNewRow,
  visibleOrder,
  type RowNode,
} from './hierarchy'

const n = (id: string, parentId: string | null, position: string): RowNode => ({ id, parentId, position })

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    Object.freeze(o)
    for (const v of Object.values(o as object)) deepFreeze(v)
  }
  return o
}

const byId = (rows: RowNode[], id: string) => rows.find((r) => r.id === id)!

// Flat: a, b, c at top level.
const flat = (): RowNode[] => [n('a', null, 'a0'), n('b', null, 'a1'), n('c', null, 'a2')]

// a
//   a1, a2
// b
//   b1
const tree = (): RowNode[] => [
  n('a', null, 'a0'),
  n('a1', 'a', 'a0'),
  n('a2', 'a', 'a1'),
  n('b', null, 'a1'),
  n('b1', 'b', 'a0'),
]

describe('visibleOrder / fullOrder', () => {
  it('orders siblings by position, depth-first', () => {
    const shuffled = [tree()[4], tree()[2], tree()[0], tree()[3], tree()[1]]
    expect(fullOrder(shuffled)).toEqual(['a', 'a1', 'a2', 'b', 'b1'])
  })

  it('hides descendants of a collapsed row but keeps the row itself', () => {
    expect(visibleOrder(tree(), new Set(['a']))).toEqual(['a', 'b', 'b1'])
    expect(visibleOrder(tree(), new Set(['a', 'b']))).toEqual(['a', 'b'])
  })

  it('hides nested descendants of a collapsed row', () => {
    const rows = [...tree(), n('a2x', 'a2', 'a0')]
    expect(visibleOrder(rows, new Set(['a']))).toEqual(['a', 'b', 'b1'])
    expect(visibleOrder(rows, new Set(['a2']))).toEqual(['a', 'a1', 'a2', 'b', 'b1'])
  })

  it('compares positions as plain strings (uppercase before lowercase)', () => {
    const rows = [n('x', null, 'a0'), n('y', null, 'Zz')]
    expect(fullOrder(rows)).toEqual(['y', 'x'])
  })

  it('breaks position ties by id deterministically', () => {
    const rows = [n('b', null, 'a0'), n('a', null, 'a0'), n('c', null, 'a0')]
    expect(fullOrder(rows)).toEqual(['a', 'b', 'c'])
    expect(fullOrder([...rows].reverse())).toEqual(['a', 'b', 'c'])
  })

  it('treats a row with a missing parent as top-level', () => {
    const rows = [n('a', null, 'a0'), n('orphan', 'ghost', 'a1')]
    expect(fullOrder(rows)).toEqual(['a', 'orphan'])
    expect(visibleOrder(rows, new Set(['ghost']))).toEqual(['a', 'orphan'])
  })

  it('does not throw or loop on a parent cycle', () => {
    // Not a valid tree, but must never throw or loop forever.
    const rows = [n('a', 'b', 'a0'), n('b', 'a', 'a0'), n('c', null, 'a0')]
    expect(() => fullOrder(rows)).not.toThrow()
  })

  it('handles empty input', () => {
    expect(fullOrder([])).toEqual([])
  })
})

describe('indent', () => {
  it('makes row 2 the child of row 1', () => {
    const out = indent(flat(), 'b')
    expect(byId(out, 'b').parentId).toBe('a')
    expect(byId(out, 'a').parentId).toBeNull()
    expect(byId(out, 'c').parentId).toBeNull()
    expect(fullOrder(out)).toEqual(['a', 'b', 'c'])
  })

  it('returns the same reference for the first sibling', () => {
    const rows = flat()
    expect(indent(rows, 'a')).toBe(rows)
  })

  it('returns the same reference for an unknown id', () => {
    const rows = flat()
    expect(indent(rows, 'nope')).toBe(rows)
  })

  it('places the row last among the new parent\'s existing children', () => {
    const out = indent(tree(), 'b') // previous sibling is a, which has a1, a2
    expect(byId(out, 'b').parentId).toBe('a')
    expect(byId(out, 'b').position > byId(out, 'a2').position).toBe(true)
    expect(fullOrder(out)).toEqual(['a', 'a1', 'a2', 'b', 'b1'])
  })

  it('brings the row\'s own children along', () => {
    const out = indent(tree(), 'b')
    expect(byId(out, 'b1').parentId).toBe('b')
    expect(fullOrder(out)).toEqual(['a', 'a1', 'a2', 'b', 'b1'])
  })

  it('uses the immediately preceding sibling, not the first', () => {
    const out = indent(flat(), 'c')
    expect(byId(out, 'c').parentId).toBe('b')
  })

  it('treats an orphan as top-level when indenting', () => {
    const rows = [n('a', null, 'a0'), n('orphan', 'ghost', 'a1')]
    const out = indent(rows, 'orphan')
    expect(byId(out, 'orphan').parentId).toBe('a')
  })
})

describe('outdent', () => {
  it('moves a child to just after its former parent', () => {
    const out = outdent(tree(), 'a1')
    expect(byId(out, 'a1').parentId).toBeNull()
    expect(fullOrder(out)).toEqual(['a', 'a2', 'a1', 'b', 'b1'])
  })

  it('places the row before the parent\'s next sibling (strictly between)', () => {
    const out = outdent(tree(), 'a1')
    const { position } = byId(out, 'a1')
    expect(position > byId(out, 'a').position).toBe(true)
    expect(position < byId(out, 'b').position).toBe(true)
  })

  it('does not adopt following siblings', () => {
    const out = outdent(tree(), 'a1')
    expect(byId(out, 'a2').parentId).toBe('a')
  })

  it('is placed last when the parent has no next sibling', () => {
    const out = outdent(tree(), 'b1')
    expect(fullOrder(out)).toEqual(['a', 'a1', 'a2', 'b', 'b1'])
    expect(byId(out, 'b1').parentId).toBeNull()
    expect(byId(out, 'b1').position > byId(out, 'b').position).toBe(true)
  })

  it('moves to the grandparent level when nested deeper', () => {
    const rows = [n('a', null, 'a0'), n('b', 'a', 'a0'), n('c', 'b', 'a0')]
    const out = outdent(rows, 'c')
    expect(byId(out, 'c').parentId).toBe('a')
    expect(fullOrder(out)).toEqual(['a', 'b', 'c'])
  })

  it('returns the same reference for a top-level row', () => {
    const rows = tree()
    expect(outdent(rows, 'a')).toBe(rows)
  })

  it('returns the same reference for an unknown id', () => {
    const rows = tree()
    expect(outdent(rows, 'nope')).toBe(rows)
  })

  it('returns the same reference for an orphan (treated as top-level)', () => {
    const rows = [n('a', null, 'a0'), n('orphan', 'ghost', 'a1')]
    expect(outdent(rows, 'orphan')).toBe(rows)
  })
})

describe('moveRow', () => {
  it('yields a position strictly between its new neighbours', () => {
    const out = moveRow(flat(), 'c', 'a', null) // between a and b
    const p = byId(out, 'c').position
    expect(p > byId(out, 'a').position).toBe(true)
    expect(p < byId(out, 'b').position).toBe(true)
    expect(fullOrder(out)).toEqual(['a', 'c', 'b'])
  })

  it('afterId = null makes it the first child', () => {
    const out = moveRow(flat(), 'c', null, null)
    expect(fullOrder(out)).toEqual(['c', 'a', 'b'])
    expect(byId(out, 'c').position < byId(out, 'a').position).toBe(true)
  })

  it('moves to the end when afterId is the last sibling', () => {
    const out = moveRow(flat(), 'a', 'c', null)
    expect(fullOrder(out)).toEqual(['b', 'c', 'a'])
  })

  it('moves under a new parent after a given child', () => {
    const out = moveRow(tree(), 'b1', 'a1', 'a')
    expect(byId(out, 'b1').parentId).toBe('a')
    expect(fullOrder(out)).toEqual(['a', 'a1', 'b1', 'a2', 'b'])
  })

  it('moves under a new parent as the first child', () => {
    const out = moveRow(tree(), 'b', null, 'a')
    expect(byId(out, 'b').parentId).toBe('a')
    expect(fullOrder(out)).toEqual(['a', 'b', 'b1', 'a1', 'a2'])
  })

  it('moves into an empty parent', () => {
    const out = moveRow(flat(), 'c', null, 'a')
    expect(byId(out, 'c').parentId).toBe('a')
    expect(fullOrder(out)).toEqual(['a', 'c', 'b'])
  })

  it('excludes the moved row when finding the next sibling (reorder within parent)', () => {
    // a, b, c -> move a after b: next sibling of b is c.
    const out = moveRow(flat(), 'a', 'b', null)
    expect(fullOrder(out)).toEqual(['b', 'a', 'c'])
    const p = byId(out, 'a').position
    expect(p > byId(out, 'b').position && p < byId(out, 'c').position).toBe(true)
  })

  it('moving to the current spot keeps the order', () => {
    const out = moveRow(flat(), 'b', 'a', null)
    expect(fullOrder(out)).toEqual(['a', 'b', 'c'])
  })

  it('rejects moving a row under itself', () => {
    const rows = tree()
    expect(moveRow(rows, 'a', null, 'a')).toBe(rows)
  })

  it('rejects moving a row into its own descendant', () => {
    const rows = [...tree(), n('a2x', 'a2', 'a0')]
    expect(moveRow(rows, 'a', null, 'a1')).toBe(rows)
    expect(moveRow(rows, 'a', null, 'a2x')).toBe(rows)
  })

  it('rejects afterId that is not a child of newParentId', () => {
    const rows = tree()
    expect(moveRow(rows, 'b1', 'a1', null)).toBe(rows)
    expect(moveRow(rows, 'b1', 'b', 'a')).toBe(rows)
  })

  it('rejects afterId equal to id', () => {
    const rows = flat()
    expect(moveRow(rows, 'a', 'a', null)).toBe(rows)
  })

  it('rejects an unknown id, unknown afterId or unknown newParentId', () => {
    const rows = flat()
    expect(moveRow(rows, 'nope', null, null)).toBe(rows)
    expect(moveRow(rows, 'a', 'nope', null)).toBe(rows)
    expect(moveRow(rows, 'a', null, 'nope')).toBe(rows)
  })

  it('moves a row together with its subtree (children keep parentId)', () => {
    const out = moveRow(tree(), 'a', 'b', null)
    expect(fullOrder(out)).toEqual(['b', 'b1', 'a', 'a1', 'a2'])
    expect(byId(out, 'a1').parentId).toBe('a')
  })
})

describe('positionForNewRow', () => {
  it('returns a key after afterId and before its next sibling', () => {
    const rows = flat()
    const p = positionForNewRow(rows, null, 'a')
    expect(p > 'a0' && p < 'a1').toBe(true)
  })

  it('afterId = null gives a key before the current first child', () => {
    const p = positionForNewRow(flat(), null, null)
    expect(p < 'a0').toBe(true)
  })

  it('works for an empty parent', () => {
    const p = positionForNewRow(flat(), 'a', null)
    expect(typeof p).toBe('string')
    expect(p.length).toBeGreaterThan(0)
  })

  it('appends after the last child', () => {
    expect(positionForNewRow(flat(), null, 'c') > 'a2').toBe(true)
  })

  it('works on an empty list', () => {
    expect(typeof positionForNewRow([], null, null)).toBe('string')
  })
})

describe('deleteWithChildren', () => {
  it('removes the row and all descendants, depth-first, row first', () => {
    const rows = [...tree(), n('a2x', 'a2', 'a0')]
    const res = deleteWithChildren(rows, 'a')
    expect(res.removedIds).toEqual(['a', 'a1', 'a2', 'a2x'])
    expect(res.rows.map((r) => r.id).sort()).toEqual(['b', 'b1'])
  })

  it('removes a leaf only', () => {
    const res = deleteWithChildren(tree(), 'a1')
    expect(res.removedIds).toEqual(['a1'])
    expect(res.rows.map((r) => r.id)).toEqual(['a', 'a2', 'b', 'b1'])
  })

  it('returns the input rows and [] for an unknown id', () => {
    const rows = tree()
    const res = deleteWithChildren(rows, 'nope')
    expect(res.rows).toBe(rows)
    expect(res.removedIds).toEqual([])
  })
})

describe('purity', () => {
  it('never mutates deep-frozen inputs', () => {
    const rows = deepFreeze([...tree(), n('a2x', 'a2', 'a0'), n('orphan', 'ghost', 'a5')])
    const collapsed = deepFreeze(new Set(['a']))
    expect(() => {
      indent(rows, 'b')
      indent(rows, 'a')
      outdent(rows, 'a1')
      outdent(rows, 'a')
      moveRow(rows, 'b1', 'a1', 'a')
      moveRow(rows, 'a', null, 'a1')
      positionForNewRow(rows, 'a', 'a1')
      deleteWithChildren(rows, 'a')
      visibleOrder(rows, collapsed)
      fullOrder(rows)
    }).not.toThrow()
  })

  it('returns new row objects for changed rows without touching the original', () => {
    const rows = flat()
    const before = JSON.stringify(rows)
    const out = indent(rows, 'b')
    expect(out).not.toBe(rows)
    expect(JSON.stringify(rows)).toBe(before)
  })
})
