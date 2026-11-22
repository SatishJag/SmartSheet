import { describe, expect, it } from 'vitest'
import { DC_MASTER_ACTIVITIES as A, DC_MASTER_TYPE as T, type DcPackage } from './dcMaster'
import { dcMasterCatalog } from './dcMasterCatalog'

const PACKAGES: DcPackage[] = ['Power Modules', 'Generator Sets', 'Transformers', 'Chillers', 'Switchgear', 'Fan Wall Units (FWU)']

describe('Data centre master catalog', () => {
  it('has the template’s 199 activities in 22 stages, targeting RFS', () => {
    expect(A).toHaveLength(199)
    expect(new Set(A.map((a) => a.stage)).size).toBe(22)
    expect(T).toMatchObject({ id: 'dc-master', name: 'Data centre master schedule', position: 0, projectTypes: ['data-centre'], targetId: 'DC-0192', targetCode: 'DC_0192' })
    const rfs = A.find((a) => a.id === 'DC-0192')!
    expect(rfs).toMatchObject({ code: 'DC_0192', milestone: true, defaultDays: 0 })
    expect(rfs.name).toMatch(/READY FOR SERVICE/)
    expect(A.every((a) => a.code === a.id.replace('-', '_') && /^[A-Z0-9_]+$/.test(a.code))).toBe(true)
    expect(A.filter((a) => a.milestone).every((a) => a.defaultDays === 0)).toBe(true)
  })

  it('has resolvable, acyclic links', () => {
    const codes = new Set(A.map((a) => a.code))
    const links = A.flatMap((a) => a.links.map((l) => ({ ...l, to: a.code })))
    expect(links).toHaveLength(355)
    expect(links.every((l) => codes.has(l.from) && l.from !== l.to)).toBe(true)
    expect(A.filter((a) => a.links.length === 0).map((a) => a.id)).toEqual(['DC-0001'])
    // Kahn's algorithm: every activity gets placed only when there is no cycle.
    const indegree = new Map(A.map((a) => [a.code, a.links.length]))
    const queue = A.filter((a) => a.links.length === 0).map((a) => a.code)
    let placed = 0
    while (queue.length > 0) {
      const at = queue.shift()!
      placed++
      for (const l of links.filter((x) => x.from === at)) {
        indegree.set(l.to, indegree.get(l.to)! - 1)
        if (indegree.get(l.to) === 0) queue.push(l.to)
      }
    }
    expect(placed).toBe(199)
  })

  it('has six packages of nine steps in order', () => {
    for (const p of PACKAGES) {
      const steps = A.filter((a) => a.package === p)
      expect(steps.map((s) => s.step), p).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
      expect(steps[8].milestone, p).toBe(true)
      expect(steps[4].defaultDays, p).toBe(202)
      expect(steps[5].links, p).toContainEqual({ from: steps[4].code, type: 'SS', lagDays: 172 })
    }
    expect(A.filter((a) => a.package)).toHaveLength(54)
  })

  it('includes the conditional activities', () => {
    expect(A.map((a) => a.id)).toEqual(expect.arrayContaining(['DC-0043', 'DC-0109']))
  })

  it('maps to catalog activities', () => {
    const catalog = dcMasterCatalog()
    expect(catalog.map((c) => c.sequence)).toEqual(A.map((_, i) => i + 1))
    expect(catalog.filter((c) => c.isTarget).map((c) => c.code)).toEqual(['DC_0192'])
    expect(catalog[0]).toEqual({
      scheduleType: 'dc-master',
      code: A[0].code,
      name: A[0].name,
      phase: A[0].stage,
      sequence: 1,
      defaultLinks: [],
      defaultDays: A[0].defaultDays,
      isTarget: false,
      activityId: 'DC-0001',
      responsibility: A[0].responsibility,
      criteria: A[0].criteria,
    })
  })
})
