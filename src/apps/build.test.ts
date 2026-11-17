import { describe, expect, it } from 'vitest'
import { validateCell } from '../model/validate'
import { blankPerson } from '../rm/types'
import { buildApp } from './build'
import { APP_TEMPLATES, DATA_CENTER } from './catalog'

const opts = { projectName: 'DC1 Ashburn', client: 'Hyperscale Co', startDate: '2026-11-21', ownerId: 'u1', withResources: true }

describe('buildApp', () => {
  it.each(APP_TEMPLATES.map((t) => [t.name, t] as const))('%s builds valid sheets whose cells pass validation', (_name, template) => {
    const app = buildApp(template, opts)
    expect(app.sheets).toHaveLength(1 + template.supportSheets.length)
    for (const s of app.sheets) {
      for (const r of s.rows) {
        for (const [colId, value] of Object.entries(r.cells)) {
          const col = s.columns.find((c) => c.id === colId)!
          const res = validateCell(col, String(Array.isArray(value) ? value.join(',') : value), {
            rowCount: s.rows.length,
            ownRowNumber: 1,
            hoursPerDay: 8,
            dependenciesEnabled: s.sheet.dependenciesEnabled,
          })
          expect(res.ok, `${s.sheet.name} / ${col.title} = ${String(value)}`).toBe(true)
        }
      }
    }
  })

  it('schedules the plan from the next working day with finish-to-start links', () => {
    const app = buildApp(DATA_CENTER, opts)
    expect(app.starts_at).toBe('2026-11-23') // Saturday -> Monday
    const plan = app.sheets[0]
    expect(plan.sheet.name).toBe('DC1 Ashburn – Project plan')
    expect(plan.sheet.dependenciesEnabled).toBe(true)
    const start = plan.columns.find((c) => c.title === 'Start')!.id
    const end = plan.columns.find((c) => c.title === 'End')!.id
    const task = plan.columns.find((c) => c.title === 'Task')!.id
    const byName = new Map(plan.rows.map((r) => [r.cells[task], r]))
    // Site selection: 15 working days from Mon Nov 23 -> Fri Dec 11
    expect(byName.get('Site selection and feasibility')!.cells).toMatchObject({ [start]: '2026-11-23', [end]: '2026-12-11' })
    // Parallel task starts with it
    expect(byName.get('Utility power availability study')!.cells[start]).toBe('2026-11-23')
    // Phases are parents with rolled-up dates
    const phase = byName.get('Site and due diligence')!
    expect(phase.parentId).toBeNull()
    expect(phase.cells[start]).toBe('2026-11-23')
    expect(plan.dependencies.length).toBeGreaterThan(10)
    // The milestone after a parallel group waits for every task in the group
    const acquired = byName.get('Site acquired')!
    const preds = plan.dependencies.filter((d) => d.successorId === acquired.id).map((d) => plan.rows.find((r) => r.id === d.predecessorId)!.cells[task])
    expect(preds).toEqual(['Site selection and feasibility', 'Utility power availability study', 'Fiber route and carrier diversity'])
    expect(acquired.cells[start]).toBe('2026-12-21') // after the 20-day power study
    expect(app.ends_at > '2027-06-01').toBe(true)
    // Every row lies within the plan span
    for (const r of plan.rows) expect(String(r.cells[end]) <= app.ends_at).toBe(true)
  })

  it('creates one placeholder per role, reusing existing ones, and per-phase assignments', () => {
    const existing = [{ ...blankPerson(), id: 'p1', first_name: 'Project Manager', role: 'Project Manager', member_type: 'placeholder' as const }]
    const app = buildApp(DATA_CENTER, opts, existing)
    const roles = app.resources!.newPeople.map((p) => p.role)
    expect(roles).not.toContain('Project Manager')
    expect(roles).toContain('Commissioning Agent')
    expect(new Set(roles).size).toBe(roles.length)
    const cx = app.resources!.assignments.filter((a) => a.role === 'Commissioning Agent')
    expect(cx).toHaveLength(1)
    expect(cx[0].allocation_percent).toBe(100)
    expect(app.resources!.project).toMatchObject({ name: 'DC1 Ashburn', client: 'Hyperscale Co', budget_type: 'days', starts_at: '2026-11-23' })
    expect(app.resources!.project.budget_days).toBeGreaterThan(0)
  })

  it('skips resource management when asked', () => {
    expect(buildApp(DATA_CENTER, { ...opts, withResources: false }).resources).toBeNull()
  })
})
