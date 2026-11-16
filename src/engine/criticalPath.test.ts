import { describe, expect, it } from 'vitest'
import { addWorkingDays, defaultCalendar, nextWorkingDay } from './calendar'
import { analyzeCriticalPath, depKey } from './criticalPath'
import { schedule, type SchedDep, type SchedRow } from './schedule'
import type { Calendar, DepType } from './types'

const DAY = 8 * 60

function row(id: string, days: number, manualStart: string | null = null, parentId: string | null = null): SchedRow {
  return { id, parentId, durationMinutes: days * DAY, elapsed: false, manualStart, percentComplete: 0 }
}

function dep(predecessorId: string, successorId: string, type: DepType = 'FS', lagDays = 0): SchedDep {
  return { predecessorId, successorId, type, lagMinutes: lagDays * DAY }
}

function analyze(rows: SchedRow[], deps: SchedDep[], cal: Calendar = defaultCalendar) {
  const result = schedule(rows, deps, cal)
  return { result, cp: analyzeCriticalPath(rows, deps, cal, result) }
}

// 2026-11-09 is a Monday.
describe('analyzeCriticalPath', () => {
  // A(3d) -> B(2d) -> D(1d), and A -> C(1d) -> D, all finish-to-start.
  const rows = [row('A', 3, '2026-11-09'), row('B', 2), row('C', 1), row('D', 1)]
  const deps = [dep('A', 'B'), dep('A', 'C'), dep('B', 'D'), dep('C', 'D')]

  it('marks the longest chain critical and gives the shorter branch float in working days', () => {
    const { cp } = analyze(rows, deps)
    expect(cp.projectEnd).toBe('2026-11-16') // D on Monday
    for (const id of ['A', 'B', 'D']) {
      expect(cp.byRow[id]).toMatchObject({ totalFloat: 0, freeFloat: 0, critical: true })
    }
    // C runs Thu 11-12 but could slip to Fri 11-13 (D starts Mon 11-16): one working day.
    expect(cp.byRow.C).toEqual({
      lateStart: '2026-11-13',
      lateFinish: '2026-11-13',
      totalFloat: 1,
      freeFloat: 1,
      critical: false,
    })
  })

  it('reports late dates for critical rows equal to their early dates', () => {
    const { cp, result } = analyze(rows, deps)
    expect(cp.byRow.B.lateStart).toBe(result.byRow.B.start)
    expect(cp.byRow.B.lateFinish).toBe(result.byRow.B.end)
  })

  it('lists the tight dependencies between critical rows, and not the slack branch', () => {
    const { cp } = analyze(rows, deps)
    expect([...cp.criticalDeps].sort()).toEqual([depKey('A', 'B'), depKey('B', 'D')])
  })

  it('a lone task is critical, and independent tasks float by the difference in length', () => {
    const { cp } = analyze([row('A', 5, '2026-11-09'), row('B', 2, '2026-11-09')], [])
    expect(cp.byRow.A).toMatchObject({ totalFloat: 0, critical: true })
    // B ends Tue 11-10 but may end Fri 11-13 with the project: 3 working days.
    expect(cp.byRow.B).toMatchObject({ lateStart: '2026-11-12', lateFinish: '2026-11-13', totalFloat: 3, freeFloat: 3, critical: false })
  })

  it('counts float across a weekend and over a non-working date', () => {
    const cal: Calendar = { ...defaultCalendar, nonWorkingDates: ['2026-11-17'] }
    // A 1d Mon 11-09; long chain L1(5d) -> L2(1d): L1 Tue 11-10..Mon 11-16, L2 Wed 11-18 (17th off).
    const rows2 = [row('A', 1, '2026-11-09'), row('L1', 5, '2026-11-10'), row('L2', 1)]
    const { cp } = analyze(rows2, [dep('L1', 'L2')], cal)
    expect(cp.projectEnd).toBe('2026-11-18')
    // A (Mon 11-09) may slip until Wed 11-18: Tue, Wed 11-11, Thu, Fri, Mon 11-16, Wed 11-18 = 6 days.
    expect(cp.byRow.A.totalFloat).toBe(6)
    expect(cp.byRow.A.lateStart).toBe('2026-11-18')
  })

  it('milestones take part: a milestone ending the chain is critical', () => {
    const { cp } = analyze([row('A', 2, '2026-11-09'), row('M', 0)], [dep('A', 'M')])
    expect(cp.byRow.M).toMatchObject({ totalFloat: 0, critical: true })
    expect(cp.byRow.A).toMatchObject({ totalFloat: 0, critical: true })
  })

  describe('lags, leads and other link types', () => {
    it('FS with lag: the chain through the lag stays critical, a parallel short task floats', () => {
      const { cp } = analyze([row('A', 2, '2026-11-09'), row('B', 2), row('S', 1, '2026-11-09')], [dep('A', 'B', 'FS', 2)])
      // A Mon-Tue, B starts Fri 11-13 (Wed, Thu lag) ends Mon 11-16.
      expect(cp.projectEnd).toBe('2026-11-16')
      expect(cp.byRow.A.critical).toBe(true)
      expect(cp.byRow.B.critical).toBe(true)
      expect(cp.byRow.S.totalFloat).toBe(5) // Mon 11-09 to Mon 11-16
    })

    it('SS: a predecessor can start as late as the successor starts (less lag)', () => {
      // A 4d Mon-Thu; B (1d) SS+1d from A starts Tue; B is not critical (project ends Thu).
      const { cp, result } = analyze([row('A', 4, '2026-11-09'), row('B', 1)], [dep('A', 'B', 'SS', 1)])
      expect(result.byRow.B.start).toBe('2026-11-10')
      expect(cp.byRow.A.critical).toBe(true)
      expect(cp.byRow.B.totalFloat).toBe(2) // may slip Tue -> Thu 11-12
      expect(cp.byRow.B.freeFloat).toBe(2)
    })

    it('FF: successor finishing with the predecessor', () => {
      const { cp } = analyze([row('A', 3, '2026-11-09'), row('B', 1)], [dep('A', 'B', 'FF')])
      // B ends Wed 11-11 with A; both end the project.
      expect(cp.byRow.A.critical).toBe(true)
      expect(cp.byRow.B.critical).toBe(true)
    })

    it('SF: the predecessor start bounds the successor finish', () => {
      const { cp, result } = analyze([row('A', 1, '2026-11-11'), row('B', 2)], [dep('A', 'B', 'SF')])
      // B must finish when A starts (Wed 11-11): B Tue 11-10 - Wed 11-11, and B drives the finish.
      expect(result.byRow.B.end).toBe('2026-11-11')
      expect(cp.byRow.A.totalFloat).toBeGreaterThanOrEqual(0)
      expect(cp.byRow.B.totalFloat).toBeGreaterThanOrEqual(0)
    })
  })

  describe('summary rows', () => {
    const tree = [
      row('P', 0, null),
      row('A', 3, '2026-11-09', 'P'),
      row('B', 1, null, 'P'),
      row('X', 1, '2026-11-09'),
    ]
    it('a summary is critical when a child is, with the smallest float and widest late dates', () => {
      const { cp } = analyze(tree, [dep('A', 'B')])
      expect(cp.byRow.P).toMatchObject({ critical: true, totalFloat: 0 })
      expect(cp.byRow.X.totalFloat).toBe(3)
    })
  })

  describe('rows that cannot be analysed', () => {
    it('skips rows the scheduler could not place, and never throws on a cycle', () => {
      const rows2 = [row('A', 1, '2026-11-09'), row('B', 1), row('C', 1), row('Z', 1)]
      const deps2 = [dep('B', 'C'), dep('C', 'B')]
      const { cp, result } = analyze(rows2, deps2)
      expect(result.errors.length).toBeGreaterThan(0)
      expect(cp.byRow.B).toBeUndefined()
      expect(cp.byRow.C).toBeUndefined()
      expect(cp.byRow.A).toMatchObject({ critical: true })
    })

    it('returns an empty analysis for no rows', () => {
      const { cp } = analyze([], [])
      expect(cp).toEqual({ byRow: {}, projectEnd: null, criticalDeps: [] })
    })
  })

  describe.each([
    ['Monday to Friday', defaultCalendar],
    ['six-day week with holidays', { ...defaultCalendar, workingWeekdays: [1, 2, 3, 4, 5, 6], nonWorkingDates: ['2026-11-11', '2026-11-17', '2026-11-24'] }],
  ] as [string, Calendar][])('against the forward scheduler (randomized), %s', (_name, cal) => {
    // Small deterministic PRNG so failures reproduce.
    function rng(seed: number) {
      return () => {
        seed = (seed * 1664525 + 1013904223) % 4294967296
        return seed / 4294967296
      }
    }

    function network(seed: number) {
      const rand = rng(seed)
      const n = 4 + Math.floor(rand() * 7)
      const rows: SchedRow[] = []
      const deps: SchedDep[] = []
      for (let i = 0; i < n; i++) {
        const id = `T${i}`
        const days = rand() < 0.15 ? 0 : 1 + Math.floor(rand() * 5)
        rows.push(row(id, days, i === 0 || rand() < 0.2 ? addWorkingDays(cal, nextWorkingDay(cal, '2026-11-09'), Math.floor(rand() * 4)) : null))
        // Earlier rows only, so the network is acyclic.
        for (let j = 0; j < i; j++) {
          if (rand() < 0.3) {
            const type = (['FS', 'FS', 'FS', 'SS', 'FF', 'SF'] as const)[Math.floor(rand() * 6)]
            deps.push(dep(`T${j}`, id, type, Math.floor(rand() * 5) - 1))
          }
        }
      }
      // Rows with neither a manual start nor a predecessor cannot be scheduled: give them one.
      const driven = new Set(deps.map((d) => d.successorId))
      for (const r of rows) if (!driven.has(r.id) && !r.manualStart) r.manualStart = nextWorkingDay(cal, '2026-11-09')
      return { rows, deps }
    }

    /** Delays one row's start by k working days by lengthening every incoming lag (or its manual start). */
    function delayed(rows: SchedRow[], deps: SchedDep[], id: string, k: number) {
      const incoming = deps.filter((d) => d.successorId === id)
      if (incoming.length === 0) {
        return {
          rows: rows.map((r) => (r.id === id ? { ...r, manualStart: addWorkingDays(cal, r.manualStart!, k) } : r)),
          deps,
        }
      }
      return { rows, deps: deps.map((d) => (d.successorId === id ? { ...d, lagMinutes: d.lagMinutes + k * DAY } : d)) }
    }

    const projectEndOf = (rows: SchedRow[], deps: SchedDep[]) => {
      const res = schedule(rows, deps, cal)
      expect(res.errors).toEqual([])
      return Object.values(res.byRow).reduce((m, s) => (s.end > m ? s.end : m), '')
    }

    it('delaying a row by its total float keeps the finish; one day more moves it', () => {
      let checked = 0
      for (let seed = 1; seed <= 250; seed++) {
        const { rows, deps } = network(seed)
        const res = schedule(rows, deps, cal)
        if (res.errors.length > 0) continue
        const cp = analyzeCriticalPath(rows, deps, cal, res)
        const end = projectEndOf(rows, deps)
        expect(cp.projectEnd).toBe(end)
        for (const r of rows) {
          const info = cp.byRow[r.id]
          expect(info.totalFloat, `seed ${seed} ${r.id}`).toBeGreaterThanOrEqual(0)
          expect(info.freeFloat, `seed ${seed} ${r.id}`).toBeGreaterThanOrEqual(0)
          expect(info.freeFloat, `seed ${seed} ${r.id}`).toBeLessThanOrEqual(info.totalFloat)
          const f = info.totalFloat
          const within = delayed(rows, deps, r.id, f)
          expect(projectEndOf(within.rows, within.deps), `seed ${seed} ${r.id} +${f}`).toBe(end)
          const beyond = delayed(rows, deps, r.id, f + 1)
          expect(projectEndOf(beyond.rows, beyond.deps) > end, `seed ${seed} ${r.id} +${f + 1}`).toBe(true)
          checked++
        }
      }
      expect(checked).toBeGreaterThan(600)
    })
  })
})
