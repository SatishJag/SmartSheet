// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { CATALOG, STATS, validProposal } from './__fixtures__/lle'
import { validateDraft } from './validateDraft'

const ctx = { catalog: CATALOG, stats: STATS }

function errorsOf(input: unknown): string[] {
  const r = validateDraft(input, ctx)
  return r.ok ? [] : r.errors
}

function expectError(input: unknown, pattern: RegExp) {
  const errors = errorsOf(input)
  expect(errors.length, 'expected the draft to be rejected').toBeGreaterThan(0)
  expect(errors.some((e) => pattern.test(e)), `no error matched ${pattern}: ${errors.join(' | ')}`).toBe(true)
}

describe('validateDraft', () => {
  it('accepts a valid plan and returns it normalized', () => {
    const r = validateDraft(validProposal(), ctx)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.activities).toHaveLength(8)
    expect(r.plan.targetCode).toBe('SITE')
    expect(r.plan.links[0]).toEqual({ from: 'SPEC', to: 'RFQ', type: 'FS', lagDays: 0 })
  })

  it('takes activity names and phases from the catalog', () => {
    const p = validProposal()
    p.activities[0].name = 'Something the model made up'
    p.activities[0].phase = 'Nope'
    const r = validateDraft(p, ctx)
    expect(r.ok && r.plan.activities[0]).toMatchObject({ name: 'Technical specification', phase: 'Engineering' })
  })

  it('accepts a subset of the catalog as long as the logic ends at the target', () => {
    const p = validProposal()
    p.activities = p.activities.filter((a) => a.code !== 'FAT')
    p.links = p.links.filter((l) => l.from !== 'FAT' && l.to !== 'FAT')
    p.links.push({ from: 'FAB', to: 'SHIP', type: 'FS', lagDays: 0 })
    expect(errorsOf(p)).toEqual([])
  })

  it('accepts an adjusted duration with a reason', () => {
    const p = validProposal()
    p.activities[4] = { ...p.activities[4], durationDays: 190, basis: 'adjusted', reason: 'New vendor: p80 plus margin.' }
    expect(errorsOf(p)).toEqual([])
  })

  it('rejects input that is not an object or misses arrays', () => {
    expectError(null, /object/)
    expectError({ ...validProposal(), activities: 'x' }, /activities/)
    expectError({ ...validProposal(), links: undefined }, /links/)
  })

  it('rejects codes outside the catalog', () => {
    const p = validProposal()
    p.activities[1].code = 'BRIBE'
    expectError(p, /BRIBE.*not in the catalog/)
  })

  it('rejects duplicate codes', () => {
    const p = validProposal()
    p.activities.push({ ...p.activities[0] })
    expectError(p, /duplicate.*SPEC/i)
  })

  it('requires the target to be the catalog target and present', () => {
    expectError({ ...validProposal(), targetCode: 'SHIP' }, /target.*SITE/)
    const p = validProposal()
    p.activities = p.activities.filter((a) => a.code !== 'SITE')
    p.links = p.links.filter((l) => l.to !== 'SITE')
    expectError(p, /target/)
  })

  it('rejects non-integer, negative and too long durations', () => {
    for (const d of [12.5, -1, 521, Number.NaN]) {
      const p = validProposal()
      p.activities[0] = { ...p.activities[0], durationDays: d, basis: 'adjusted' }
      expectError(p, /SPEC.*duration/)
    }
  })

  it('allows 0 days only for milestones and requires milestones to be 0', () => {
    const p = validProposal()
    p.activities[0] = { ...p.activities[0], durationDays: 0, basis: 'adjusted' }
    expectError(p, /SPEC.*0/)
    const q = validProposal()
    q.activities[2] = { ...q.activities[2], durationDays: 3, basis: 'adjusted' }
    expectError(q, /PO.*milestone/)
  })

  it('requires the basis to match the statistic it cites', () => {
    const p = validProposal()
    p.activities[0] = { ...p.activities[0], durationDays: 30, basis: 'p50' }
    expectError(p, /SPEC.*p50.*12/)
    const q = validProposal()
    q.activities[0] = { ...q.activities[0], durationDays: 7, basis: 'default' }
    expectError(q, /SPEC.*default.*10/)
    const r = validProposal()
    r.activities[0] = { ...r.activities[0], basis: 'gut feel' }
    expectError(r, /SPEC.*basis/)
  })

  it('accepts a rounded fractional statistic', () => {
    const p = validProposal()
    p.activities[1] = { ...p.activities[1], durationDays: 19, basis: 'p50' }
    expect(errorsOf(p)).toEqual([])
  })

  it('rejects p50/p80 for an activity without history', () => {
    const p = validProposal()
    p.activities[2] = { ...p.activities[2], basis: 'p50' }
    expectError(p, /PO.*no history/)
  })

  it('requires a reason', () => {
    const p = validProposal()
    p.activities[0] = { ...p.activities[0], reason: ' ' }
    expectError(p, /SPEC.*reason/)
  })

  it('rejects links to unknown codes, bad types, non-integer lags, self links and duplicates', () => {
    const add = (link: Record<string, unknown>) => {
      const p = validProposal()
      ;(p.links as unknown[]).push(link)
      return p
    }
    expectError(add({ from: 'SPEC', to: 'XYZ', type: 'FS', lagDays: 0 }), /XYZ/)
    expectError(add({ from: 'SPEC', to: 'PO', type: 'XX', lagDays: 0 }), /type/)
    expectError(add({ from: 'SPEC', to: 'PO', type: 'SS', lagDays: 1.5 }), /lag/)
    expectError(add({ from: 'SPEC', to: 'SPEC', type: 'FS', lagDays: 0 }), /itself/)
    expectError(add({ from: 'SPEC', to: 'RFQ', type: 'SS', lagDays: 0 }), /duplicate/i)
  })

  it('rejects links to codes that are in the catalog but not in the plan', () => {
    const p = validProposal()
    p.activities = p.activities.filter((a) => a.code !== 'FAT')
    expectError(p, /FAT/)
  })

  it('rejects cycles', () => {
    const p = validProposal()
    p.links.push({ from: 'FAB', to: 'DWG', type: 'FS', lagDays: 0 })
    expectError(p, /cycle/i)
  })

  it('requires the target to end the logic', () => {
    const p = validProposal()
    p.links.push({ from: 'SITE', to: 'SHIP', type: 'SS', lagDays: 0 })
    expectError(p, /SITE.*successor|cycle/i)
    const q = validProposal()
    q.links = q.links.filter((l) => !(l.from === 'FAT' && l.to === 'SHIP'))
    expectError(q, /FAT.*does not lead to the target/)
  })

  it('bounds the text fields', () => {
    expectError({ ...validProposal(), summary: '' }, /summary/)
    expectError({ ...validProposal(), summary: 'x'.repeat(5000) }, /summary/)
    expectError({ ...validProposal(), risks: [42] }, /risks/)
    expectError({ ...validProposal(), assumptions: Array(50).fill('a') }, /assumptions/)
  })

  it('reports a broken catalog', () => {
    const r = validateDraft(validProposal(), { catalog: CATALOG.map((a) => ({ ...a, isTarget: false })), stats: STATS })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/catalog/)
  })
})
