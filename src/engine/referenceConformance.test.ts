import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { schedule, type SchedDep, type SchedRow } from './schedule'
import type { Calendar, DepType } from './types'

/**
 * Conformance with the observed reference product: every scenario of
 * docs/behavior/vectors/scheduling-dependencies.json becomes one engine call whose dates must equal
 * the observed ones. The scenarios live in one sheet (rows reference each other by scenario number).
 */
interface Scenario {
  n: number
  name: string
  typed_start: string | null
  typed_dur: number | null
  preds: [number, DepType, number][]
  start: string
  end: string
  duration: string
}
interface Vectors {
  calendar: { workingDays: string[]; nonWorkingDays: string[]; lengthOfDay: number }
  results: Scenario[]
}

const vectors: Vectors = JSON.parse(
  readFileSync(resolve(process.cwd(), 'docs/behavior/vectors/scheduling-dependencies.json'), 'utf8'),
)
const WEEKDAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']

function calendarWith(nonWorkingStart: 'shift' | 'keep' | undefined): Calendar {
  const cal: Calendar = {
    workingWeekdays: vectors.calendar.workingDays.map((d) => WEEKDAYS.indexOf(d)),
    nonWorkingDates: vectors.calendar.nonWorkingDays,
    hoursPerDay: vectors.calendar.lengthOfDay,
  }
  return nonWorkingStart ? { ...cal, nonWorkingStart } : cal
}

const DAY = vectors.calendar.lengthOfDay * 60

/** The scenario sheet. Rows "q..." are the children of the row named "Parent". */
function build() {
  const parent = vectors.results.find((s) => s.name === 'Parent')!
  const id = (n: number) => `r${n}`
  const rows: SchedRow[] = vectors.results.map((s) => ({
    id: id(s.n),
    parentId: /^q\d/.test(s.name) ? id(parent.n) : null,
    durationMinutes: (s.typed_dur ?? 0) * DAY,
    elapsed: false,
    manualStart: s.typed_start,
    percentComplete: 0,
  }))
  const deps: SchedDep[] = vectors.results.flatMap((s) =>
    s.preds.map(([p, type, lag]) => ({ predecessorId: id(p), successorId: id(s.n), type, lagMinutes: lag * DAY })),
  )
  return { rows, deps, id }
}

/** Scenarios where a typed start sits on a non-working day (the 'nonWorkingStart' option decides). */
const NON_WORKING_START = new Set(
  vectors.results.filter((s) => s.typed_start && !calendarWith('keep').workingWeekdays.includes(new Date(`${s.typed_start}T00:00:00Z`).getUTCDay())).map((s) => s.n),
)

describe('reference conformance (docs/behavior/vectors/scheduling-dependencies.json)', () => {
  it('has the 24 observed scenarios, two of them typed on a weekend', () => {
    expect(vectors.results).toHaveLength(24)
    expect([...NON_WORKING_START].sort((a, b) => a - b)).toEqual([4, 5])
  })

  describe("with nonWorkingStart 'keep' (the reference behaviour)", () => {
    const { rows, deps, id } = build()
    const result = schedule(rows, deps, calendarWith('keep'))

    it('schedules every row without errors', () => {
      expect(result.errors).toEqual([])
    })

    it.each(vectors.results.map((s) => [s.n, s.name, s] as const))('scenario %i: %s', (_n, _name, s) => {
      const got = result.byRow[id(s.n)]
      expect({ start: got.start, end: got.end }).toEqual({ start: s.start, end: s.end })
      // "3d" -> 3 working days, "0" -> milestone; a summary row shows the working days it spans.
      expect(got.durationDays).toBe(parseInt(s.duration, 10))
    })
  })

  describe("with the default nonWorkingStart ('shift')", () => {
    const { rows, deps, id } = build()
    const result = schedule(rows, deps, calendarWith(undefined))

    it('matches every scenario except the weekend-typed starts, which move to the next working day', () => {
      for (const s of vectors.results) {
        const got = result.byRow[id(s.n)]
        if (NON_WORKING_START.has(s.n)) continue
        expect({ n: s.n, start: got.start, end: got.end }).toEqual({ n: s.n, start: s.start, end: s.end })
      }
      // D: Sat 03-14, 2d -> Mon 03-16 .. Tue 03-17;  E: Sun 03-15, 1d -> Mon 03-16.
      expect(result.byRow[id(4)]).toMatchObject({ start: '2026-03-16', end: '2026-03-17' })
      expect(result.byRow[id(5)]).toMatchObject({ start: '2026-03-16', end: '2026-03-16' })
    })

    it("treats an explicit 'shift' like the default", () => {
      const explicit = schedule(rows, deps, calendarWith('shift'))
      expect(explicit.byRow).toEqual(result.byRow)
    })
  })
})
