import { describe, it, expect } from 'vitest'
import { findCycle, findCycleRows } from './cycles'
import type { SchedDep } from './schedule'

function dep(predecessorId: string, successorId: string): SchedDep {
  return { predecessorId, successorId, type: 'FS', lagMinutes: 0 }
}

describe('findCycle', () => {
  it('returns the rows of a three-row cycle', () => {
    const cycle = findCycle([dep('A', 'B'), dep('B', 'C'), dep('C', 'A')])
    expect(cycle).not.toBeNull()
    expect([...cycle!].sort()).toEqual(['A', 'B', 'C'])
  })

  it('returns the cycle in dependency order', () => {
    expect(findCycle([dep('A', 'B'), dep('B', 'C'), dep('C', 'A')])).toEqual(['A', 'B', 'C'])
  })

  it('returns null for acyclic input', () => {
    expect(findCycle([dep('A', 'B'), dep('B', 'C'), dep('A', 'C')])).toBeNull()
    expect(findCycle([])).toBeNull()
  })

  it('returns [A] for a self-dependency', () => {
    expect(findCycle([dep('A', 'A')])).toEqual(['A'])
  })

  it('finds a cycle that is not reachable from the first row', () => {
    const cycle = findCycle([dep('A', 'B'), dep('X', 'Y'), dep('Y', 'X')])
    expect([...cycle!].sort()).toEqual(['X', 'Y'])
  })

  it('does not overflow the stack on a long chain', () => {
    const deps: SchedDep[] = []
    for (let i = 0; i < 20000; i++) deps.push(dep(`r${i}`, `r${i + 1}`))
    expect(findCycle(deps)).toBeNull()
    deps.push(dep('r20000', 'r0'))
    expect(findCycle(deps)).toHaveLength(20001)
  })
})

describe('findCycleRows', () => {
  it('is empty for acyclic input', () => {
    expect(findCycleRows([dep('A', 'B')]).size).toBe(0)
  })

  it('includes every row in any cycle but not rows merely downstream or upstream', () => {
    const rows = findCycleRows([
      dep('U', 'A'), // upstream of cycle
      dep('A', 'B'),
      dep('B', 'A'),
      dep('B', 'D'), // downstream of cycle
      dep('X', 'Y'),
      dep('Y', 'Z'),
      dep('Z', 'X'),
      dep('S', 'S'),
    ])
    expect([...rows].sort()).toEqual(['A', 'B', 'S', 'X', 'Y', 'Z'])
  })

  it('does not count a single row without a self-edge', () => {
    expect(findCycleRows([dep('A', 'B')]).has('A')).toBe(false)
  })
})
