import { describe, expect, it } from 'vitest'
import { bucketsFor, buildLoad, findAvailable, isoOfDay, dayNumber, utilizationSummary, type Assignment, type Resource, type TaskFact } from './engine'
import { suggestLeveling } from './leveling'
import { CAL } from './testkit'

/** 500 resources, 5,000 tasks, 10,000 assignments over a year: the plan's stated scale. */
function bigPlan() {
  let seed = 7
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }
  const base = dayNumber('2026-11-16')
  const resources: Resource[] = Array.from({ length: 500 }, (_, i) => ({
    id: `r${i}`,
    name: `Resource ${i}`,
    kind: 'person',
    department: `D${i % 12}`,
    skills: [`s${i % 7}`],
    costRate: 50,
    hoursByWeekday: [0, 8, 8, 8, 8, 8, 0],
    timeOff: i % 10 === 0 ? [{ start: '2027-01-04', end: '2027-01-15', hours: 0 }] : [],
  }))
  const tasks: TaskFact[] = []
  const assignments: Assignment[] = []
  for (let t = 0; t < 5000; t++) {
    const startDay = base + Math.floor(rnd() * 330)
    const len = 2 + Math.floor(rnd() * 12)
    const start = isoOfDay(startDay)
    const end = isoOfDay(startDay + len)
    const float = rnd() < 0.6 ? Math.floor(rnd() * 15) : 0
    tasks.push({
      sheetId: `s${t % 5}`,
      rowId: `t${t}`,
      name: `Task ${t}`,
      start,
      end,
      durationDays: len,
      elapsed: false,
      calendar: CAL,
      totalFloat: float,
      freeFloat: Math.floor(float / 2),
      critical: float === 0,
    })
    for (let k = 0; k < 2; k++) {
      assignments.push({
        id: `a${t}-${k}`,
        sheetId: `s${t % 5}`,
        rowId: `t${t}`,
        resourceId: `r${Math.floor(rnd() * 500)}`,
        allocation: { kind: 'percent', value: 25 + Math.floor(rnd() * 5) * 25 },
        startDate: null,
        endDate: null,
      })
    }
  }
  // Two assignments of one resource on one task is not allowed by the database; drop duplicates here too.
  const seen = new Set<string>()
  return {
    resources,
    tasks,
    assignments: assignments.filter((a) => {
      const k = `${a.sheetId}:${a.rowId}:${a.resourceId}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    }),
  }
}

describe('scale: 500 resources x 5,000 tasks', () => {
  const { resources, tasks, assignments } = bigPlan()
  const timings: Record<string, number> = {}
  const time = <T,>(name: string, fn: () => T): T => {
    const t0 = performance.now()
    const out = fn()
    timings[name] = Math.round(performance.now() - t0)
    return out
  }

  it('builds the load, the heat map, the summary, a search and leveling within budget', () => {
    const model = time('buildLoad', () => buildLoad(resources, assignments, tasks))
    expect(model.skipped).toHaveLength(0)

    const grid = time('heat map (500 resources x 52 weeks)', () => resources.map((r) => bucketsFor(model, r.id, 'week', '2026-11-16', '2027-11-14')))
    expect(grid).toHaveLength(500)
    expect(grid[0]).toHaveLength(52)

    time('day buckets (one resource, 1 year)', () => bucketsFor(model, 'r0', 'day', '2026-11-16', '2027-11-14'))
    const util = time('utilisation summary', () => utilizationSummary(model, '2026-11-16', '2027-11-14'))
    expect(util.some((u) => u.overDays > 0)).toBe(true)
    const found = time('find a resource (500 resources, 10 days)', () => findAvailable(model, { from: '2026-12-01', to: '2026-12-10', hoursPerDay: 4 }))
    expect(found.length).toBe(500)

    const lev = time('suggestLeveling (100 suggestions)', () => suggestLeveling(resources, assignments, tasks, { maxSuggestions: 100 }))
    expect(lev.suggestions.length).toBeGreaterThan(0)
    console.info('resources scale timings (ms):', JSON.stringify(timings), `assignments=${assignments.length}`, `suggestions=${lev.suggestions.length}`, `unresolved=${lev.unresolved.length}`)

    // Generous ceilings: this is a regression guard, not a benchmark (CI machines vary).
    expect(timings.buildLoad).toBeLessThan(2000)
    expect(timings['heat map (500 resources x 52 weeks)']).toBeLessThan(2000)
    expect(timings['utilisation summary']).toBeLessThan(2000)
    expect(timings['suggestLeveling (100 suggestions)']).toBeLessThan(10_000)
  })
})
