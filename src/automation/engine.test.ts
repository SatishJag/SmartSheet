import { describe, expect, it } from 'vitest'
import type { Column } from '../model/validate'
import { createRunGuard } from './guard'
import { batchDigests, type PendingEmail } from './digest'
import { describeRule } from './describe'
import { dryRun, evaluateRowEvent, evaluateTick, MAX_CHAIN_DEPTH, renderTemplate, type EngineContext } from './engine'
import { latestOccurrence, nextDigestTime, todayIso } from './time'
import type { Action, AutomationRule, ConditionGroup, RowSnapshot, SheetEvent, Trigger } from './types'

const COLS: Column[] = [
  { id: 'task', title: 'Task', type: 'TEXT_NUMBER' },
  { id: 'status', title: 'Status', type: 'PICKLIST', options: ['Not started', 'In progress', 'Done'] },
  { id: 'owner', title: 'Owner', type: 'CONTACT_LIST' },
  { id: 'due', title: 'Due', type: 'DATE' },
  { id: 'doneOn', title: 'Done on', type: 'DATE' },
  { id: 'hours', title: 'Hours', type: 'TEXT_NUMBER' },
  { id: 'tags', title: 'Tags', type: 'MULTI_PICKLIST', options: ['a', 'b'] },
  { id: 'ok', title: 'Approved', type: 'CHECKBOX' },
]

// 2026-11-16 is a Monday. 10:00 UTC.
const NOW = Date.UTC(2026, 10, 16, 10, 0, 0)
const ctx = (over: Partial<EngineContext> = {}): EngineContext => ({ sheetId: 's1', sheetName: 'Tower A', columns: COLS, now: NOW, ...over })

const notify = (over: Partial<Extract<Action, { type: 'notify' }>> = {}): Action => ({
  type: 'notify',
  recipients: [{ kind: 'owner' }],
  frequency: 'immediately',
  include: 'all',
  linkToRow: true,
  ...over,
})

function rule(trigger: Trigger, action: Action = notify(), over: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'r1',
    sheetId: 's1',
    name: 'My rule',
    enabled: true,
    trigger,
    conditions: null,
    action,
    createdAt: new Date(NOW - 7 * 86_400_000).toISOString(),
    ...over,
  }
}

const row = (id: string, cells: Record<string, unknown>): RowSnapshot => ({ id, cells })
const changed = (before: Record<string, unknown>, after: Record<string, unknown>, origin?: string[]): SheetEvent => ({
  kind: 'row_changed',
  before: row('a', before),
  after: row('a', after),
  ...(origin ? { origin } : {}),
})

describe('row triggers', () => {
  it('row_added fires only for an added row', () => {
    const r = rule({ type: 'row_added' })
    expect(evaluateRowEvent([r], { kind: 'row_added', row: row('a', { task: 'x' }) }, ctx()).runs).toHaveLength(1)
    expect(evaluateRowEvent([r], changed({ task: 'x' }, { task: 'y' }), ctx()).runs).toHaveLength(0)
  })

  it('row_changed fires on any change, or only on the chosen columns, and not when nothing changed', () => {
    const any = rule({ type: 'row_changed' })
    const hours = rule({ type: 'row_changed', columnIds: ['hours'] }, notify(), { id: 'r2' })
    const e1 = changed({ task: 'x', hours: 1 }, { task: 'y', hours: 1 })
    expect(evaluateRowEvent([any, hours], e1, ctx()).runs.map((r) => r.ruleId)).toEqual(['r1'])
    const e2 = changed({ task: 'x', hours: 1 }, { task: 'x', hours: 2 })
    expect(evaluateRowEvent([any, hours], e2, ctx()).runs.map((r) => r.ruleId)).toEqual(['r1', 'r2'])
    expect(evaluateRowEvent([any], changed({ task: 'x' }, { task: 'x' }), ctx()).runs).toHaveLength(0)
    // "1" typed over 1 is not a change; neither is an empty string over a missing value
    expect(evaluateRowEvent([any], changed({ hours: 1 }, { hours: '1' }), ctx()).runs).toHaveLength(0)
    expect(evaluateRowEvent([any], changed({}, { task: '' }), ctx()).runs).toHaveLength(0)
  })

  it('cell_becomes fires when the cell BECOMES the value, not while it stays that value', () => {
    const r = rule({ type: 'cell_becomes', columnId: 'status', value: 'Done' })
    expect(evaluateRowEvent([r], changed({ status: 'In progress' }, { status: 'Done' }), ctx()).runs).toHaveLength(1)
    expect(evaluateRowEvent([r], changed({ status: 'done' }, { status: 'Done', task: 'x' }), ctx()).runs).toHaveLength(0)
    expect(evaluateRowEvent([r], changed({ status: 'Done' }, { status: 'In progress' }), ctx()).runs).toHaveLength(0)
    expect(evaluateRowEvent([r], { kind: 'row_added', row: row('a', { status: 'Done' }) }, ctx()).runs).toHaveLength(1)
  })

  it('checkbox cell_becomes works with true', () => {
    const r = rule({ type: 'cell_becomes', columnId: 'ok', value: true })
    expect(evaluateRowEvent([r], changed({}, { ok: true }), ctx()).runs).toHaveLength(1)
    expect(evaluateRowEvent([r], changed({ ok: true }, { ok: false }), ctx()).runs).toHaveLength(0)
  })

  it('ignores disabled rules and rules of another sheet', () => {
    const a = rule({ type: 'row_added' }, notify(), { enabled: false })
    const b = rule({ type: 'row_added' }, notify(), { id: 'r2', sheetId: 'other' })
    expect(evaluateRowEvent([a, b], { kind: 'row_added', row: row('a', {}) }, ctx()).runs).toHaveLength(0)
  })
})

describe('conditions', () => {
  const when = (conditions: ConditionGroup, cells: Record<string, unknown>, before: Record<string, unknown> = {}) =>
    evaluateRowEvent([rule({ type: 'row_changed' }, notify(), { conditions })], changed(before, { task: 'x', ...cells }), ctx()).runs.length === 1

  it('AND needs all, OR needs any, groups nest', () => {
    const and: ConditionGroup = {
      op: 'and',
      items: [
        { columnId: 'status', op: 'is', value: 'Done' },
        { columnId: 'hours', op: 'gt', value: 5 },
      ],
    }
    expect(when(and, { status: 'Done', hours: 8 })).toBe(true)
    expect(when(and, { status: 'Done', hours: 3 })).toBe(false)
    const or: ConditionGroup = { op: 'or', items: and.items }
    expect(when(or, { status: 'Done', hours: 3 })).toBe(true)
    expect(when(or, { status: 'Not started', hours: 3 })).toBe(false)
    const nested: ConditionGroup = {
      op: 'and',
      items: [{ columnId: 'status', op: 'is_not', value: 'Not started' }, { op: 'or', items: [{ columnId: 'hours', op: 'lt', value: 2 }, { columnId: 'task', op: 'contains', value: 'CONC' }] }],
    }
    expect(when(nested, { status: 'Done', hours: 9, task: 'Pour concrete' })).toBe(true)
    expect(when(nested, { status: 'Done', hours: 9, task: 'Paint' })).toBe(false)
    expect(when({ op: 'and', items: [] }, {})).toBe(true)
  })

  it('compares text without case, numbers as numbers and dates as dates', () => {
    expect(when({ op: 'and', items: [{ columnId: 'status', op: 'is', value: 'done' }] }, { status: 'Done' })).toBe(true)
    expect(when({ op: 'and', items: [{ columnId: 'hours', op: 'gte', value: 10 }] }, { hours: '10' })).toBe(true)
    expect(when({ op: 'and', items: [{ columnId: 'hours', op: 'gt', value: 9 }] }, { hours: 10 })).toBe(true) // 10 > 9, not "10" < "9"
    expect(when({ op: 'and', items: [{ columnId: 'due', op: 'lt', value: '2026-12-01' }] }, { due: '2026-11-30' })).toBe(true)
    expect(when({ op: 'and', items: [{ columnId: 'task', op: 'gt', value: 3 }] }, { task: 'abc' })).toBe(false) // not comparable
  })

  it('blank, contains on multi-pick, date relatives (clock injected: today is 2026-11-16)', () => {
    expect(when({ op: 'and', items: [{ columnId: 'owner', op: 'is_blank' }] }, {})).toBe(true)
    expect(when({ op: 'and', items: [{ columnId: 'owner', op: 'is_not_blank' }] }, { owner: 'a@b.co' })).toBe(true)
    expect(when({ op: 'and', items: [{ columnId: 'tags', op: 'contains', value: 'b' }] }, { tags: ['a', 'b'] })).toBe(true)
    expect(when({ op: 'and', items: [{ columnId: 'ok', op: 'is_blank' }] }, { ok: false })).toBe(true)
    const g = (op: 'is_today' | 'is_past' | 'is_future') => ({ op: 'and', items: [{ columnId: 'due', op }] }) as ConditionGroup
    expect(when(g('is_today'), { due: '2026-11-16' })).toBe(true)
    expect(when(g('is_past'), { due: '2026-11-15' })).toBe(true)
    expect(when(g('is_past'), { due: '2026-11-16' })).toBe(false)
    expect(when(g('is_future'), { due: '2026-11-17' })).toBe(true)
    const next = (n: number) => ({ op: 'and', items: [{ columnId: 'due', op: 'in_next_days', value: n }] }) as ConditionGroup
    expect(when(next(3), { due: '2026-11-19' })).toBe(true)
    expect(when(next(3), { due: '2026-11-20' })).toBe(false)
    expect(when(next(3), { due: '2026-11-15' })).toBe(false)
  })

  it('changed / changed_to / changed_from compare with the row before the change', () => {
    const to: ConditionGroup = { op: 'and', items: [{ columnId: 'status', op: 'changed_to', value: 'Done' }] }
    expect(when(to, { status: 'Done' }, { status: 'In progress' })).toBe(true)
    expect(when(to, { status: 'Done', hours: 1 }, { status: 'Done' })).toBe(false)
    const from: ConditionGroup = { op: 'and', items: [{ columnId: 'status', op: 'changed_from', value: 'In progress' }] }
    expect(when(from, { status: 'Done' }, { status: 'In progress' })).toBe(true)
    expect(when(from, { status: 'Done' }, { status: 'Not started' })).toBe(false)
    expect(when({ op: 'and', items: [{ columnId: 'hours', op: 'changed' }] }, { hours: 2 }, { hours: 1 })).toBe(true)
  })

  it('a condition on a deleted column never holds', () => {
    expect(when({ op: 'and', items: [{ columnId: 'gone', op: 'is_blank' }] }, {})).toBe(false)
  })
})

describe('actions', () => {
  it('notify: recipients from a contact column, fixed addresses and the owner; message templates; chosen columns', () => {
    const r = rule(
      { type: 'cell_becomes', columnId: 'status', value: 'Done' },
      notify({
        recipients: [{ kind: 'column', columnId: 'owner' }, { kind: 'email', email: 'Boss@Example.com' }, { kind: 'owner' }],
        subject: '{{Task}} finished',
        message: 'Hi, {{Task}} is {{Status}} on {{Sheet}}',
        include: 'columns',
        columnIds: ['status', 'hours', 'due'],
      }),
    )
    const e = changed({ status: 'In progress' }, { task: 'Pour slab', status: 'Done', owner: 'Ann <ann@x.io>; BOB@x.io', hours: 4 })
    const run = evaluateRowEvent([r], e, ctx()).runs[0]
    expect(run.rowLabel).toBe('Pour slab')
    const a = run.actions[0]
    if (a.type !== 'notify') throw new Error()
    expect(a.inApp).toBe(true)
    expect(a.emails).toEqual(['ann@x.io', 'bob@x.io', 'boss@example.com'])
    expect(a.subject).toBe('Pour slab finished')
    expect(a.message).toBe('Hi, Pour slab is Done on Tower A')
    expect(a.items[0].values).toEqual([
      { title: 'Status', value: 'Done' },
      { title: 'Hours', value: '4' }, // blank Due is left out
    ])
    expect(a.linkRowId).toBe('a')
    expect(a.deliverAfter).toBe(NOW)
  })

  it('notify with no recipient resolved plans nothing and says why', () => {
    const r = rule({ type: 'row_added' }, notify({ recipients: [{ kind: 'column', columnId: 'owner' }] }))
    const run = evaluateRowEvent([r], { kind: 'row_added', row: row('a', { task: 'x' }) }, ctx()).runs[0]
    expect(run.actions).toEqual([])
    expect(run.notes?.[0]).toMatch(/No recipients/)
  })

  it('daily and weekly notifications wait for the digest time (08:00; weekly on Monday)', () => {
    const daily = evaluateRowEvent([rule({ type: 'row_added' }, notify({ recipients: [{ kind: 'email', email: 'a@b.co' }], frequency: 'daily' }))], { kind: 'row_added', row: row('a', {}) }, ctx()).runs[0]
    const weekly = evaluateRowEvent([rule({ type: 'row_added' }, notify({ recipients: [{ kind: 'email', email: 'a@b.co' }], frequency: 'weekly' }))], { kind: 'row_added', row: row('a', {}) }, ctx()).runs[0]
    const d = daily.actions[0]
    const w = weekly.actions[0]
    if (d.type !== 'notify' || w.type !== 'notify') throw new Error()
    expect(new Date(d.deliverAfter).toISOString()).toBe('2026-11-17T08:00:00.000Z') // 10:00 is past today's 08:00
    expect(new Date(w.deliverAfter).toISOString()).toBe('2026-11-23T08:00:00.000Z') // next Monday
  })

  it('record_date stamps today in a date column, and refuses a non-date column', () => {
    const ok = rule({ type: 'cell_becomes', columnId: 'status', value: 'Done' }, { type: 'record_date', columnId: 'doneOn' })
    const run = evaluateRowEvent([ok], changed({}, { status: 'Done' }), ctx()).runs[0]
    expect(run.actions).toEqual([{ type: 'set_cell', rowId: 'a', columnId: 'doneOn', value: '2026-11-16' }])
    const bad = rule({ type: 'row_added' }, { type: 'record_date', columnId: 'hours' })
    const r2 = evaluateRowEvent([bad], { kind: 'row_added', row: row('a', {}) }, ctx()).runs[0]
    expect(r2.actions).toEqual([])
    expect(r2.notes?.[0]).toMatch(/not a date column/)
  })

  it('today follows the time zone offset', () => {
    expect(todayIso(Date.UTC(2026, 10, 16, 23, 30), 0)).toBe('2026-11-16')
    expect(todayIso(Date.UTC(2026, 10, 16, 23, 30), 120)).toBe('2026-11-17')
    const ok = rule({ type: 'row_added' }, { type: 'record_date', columnId: 'doneOn' })
    const run = evaluateRowEvent([ok], { kind: 'row_added', row: row('a', {}) }, ctx({ now: Date.UTC(2026, 10, 16, 23, 30), tzOffsetMinutes: 120 })).runs[0]
    expect(run.actions[0]).toMatchObject({ value: '2026-11-17' })
  })

  it('update request and approval need an address; lock and move/copy plan one action per row', () => {
    const upd = rule({ type: 'row_added' }, { type: 'update_request', recipients: [{ kind: 'column', columnId: 'owner' }], columnIds: ['status'], message: 'Please update {{Task}}', expiresInDays: 7 })
    const e = (cells: Record<string, unknown>): SheetEvent => ({ kind: 'row_added', row: row('a', cells) })
    expect(evaluateRowEvent([upd], e({ task: 'T', owner: 'a@b.co' }), ctx()).runs[0].actions).toEqual([
      { type: 'update_request', rowId: 'a', emails: ['a@b.co'], columnIds: ['status'], message: 'Please update T', expiresInDays: 7 },
    ])
    expect(evaluateRowEvent([upd], e({ task: 'T' }), ctx()).runs[0].actions).toEqual([])
    const appr = rule({ type: 'row_added' }, { type: 'approval', recipients: [{ kind: 'email', email: 'c@d.co' }], statusColumnId: 'status', pendingValue: 'In progress', approvedValue: 'Done', declinedValue: 'Not started', expiresInDays: 3 })
    const a = evaluateRowEvent([appr], e({}), ctx()).runs[0].actions[0]
    expect(a).toMatchObject({ type: 'approval', emails: ['c@d.co'], pendingValue: 'In progress', approvedValue: 'Done' })
    const lock = rule({ type: 'row_added' }, { type: 'lock', locked: true })
    expect(evaluateRowEvent([lock], e({}), ctx()).runs[0].actions).toEqual([{ type: 'lock', rowId: 'a', locked: true }])
    const mv = rule({ type: 'row_added' }, { type: 'move', targetSheetId: 's2' })
    expect(evaluateRowEvent([mv], e({}), ctx()).runs[0].actions).toEqual([{ type: 'move', rowId: 'a', targetSheetId: 's2' }])
  })

  it('a locked row refuses writes (record date, move) but can be unlocked', () => {
    const locked = new Set(['a'])
    const stamp = rule({ type: 'row_changed' }, { type: 'record_date', columnId: 'doneOn' })
    const res = evaluateRowEvent([stamp], changed({}, { task: 'x' }), ctx({ lockedRowIds: locked }))
    expect(res.runs).toHaveLength(0)
    expect(res.skipped).toMatchObject([{ reason: 'locked', ruleId: 'r1' }])
    const unlock = rule({ type: 'row_changed' }, { type: 'lock', locked: false })
    expect(evaluateRowEvent([unlock], changed({}, { task: 'x' }), ctx({ lockedRowIds: locked })).runs).toHaveLength(1)
  })

  it('renderTemplate leaves unknown names blank', () => {
    expect(renderTemplate('{{Nope}}|{{ task }}|{{TASK}}', { task: 'X' }, ctx())).toBe('|X|X')
  })
})

describe('loop protection and budget', () => {
  const stamp = rule({ type: 'row_changed' }, { type: 'record_date', columnId: 'doneOn' }) // its own write is a row change

  it('a rule never re-runs because of its own write (once per row per event)', () => {
    const first = evaluateRowEvent([stamp], changed({ task: 'a' }, { task: 'b' }), ctx())
    expect(first.runs).toHaveLength(1)
    // the executor writes the cell and feeds the change back, tagged with the rule that caused it
    const second = evaluateRowEvent([stamp], changed({ task: 'b' }, { task: 'b', doneOn: '2026-11-16' }, ['r1']), ctx())
    expect(second.runs).toHaveLength(0)
    expect(second.skipped).toMatchObject([{ ruleId: 'r1', reason: 'loop' }])
  })

  it('two rules that feed each other stop after one pass each', () => {
    const a = rule({ type: 'cell_becomes', columnId: 'status', value: 'Done' }, { type: 'record_date', columnId: 'doneOn' }, { id: 'A' })
    const b = rule({ type: 'row_changed', columnIds: ['doneOn'] }, { type: 'record_date', columnId: 'due' }, { id: 'B' })
    const c = rule({ type: 'row_changed', columnIds: ['due'] }, { type: 'record_date', columnId: 'doneOn' }, { id: 'C' })
    const rules = [a, b, c]
    let event: SheetEvent = changed({ status: 'In progress' }, { status: 'Done' })
    const fired: string[] = []
    for (let i = 0; i < 10; i++) {
      const res = evaluateRowEvent(rules, event, ctx())
      if (res.runs.length === 0) break
      const run = res.runs[0]
      fired.push(run.ruleId)
      const act = run.actions[0]
      if (act.type !== 'set_cell') throw new Error()
      const before = event.kind === 'row_changed' ? event.after : event.row
      // the cell takes a new value each time so every write really is a change
      const after = row('a', { ...before.cells, [act.columnId]: `2026-11-${10 + i}` })
      event = { kind: 'row_changed', before, after, origin: [...(event.origin ?? []), run.ruleId] }
    }
    expect(fired).toEqual(['A', 'B', 'C']) // B changed `due`, C changed `doneOn`; A is not allowed again, B is not either
    expect(new Set(fired).size).toBe(fired.length)
  })

  it('a chain longer than the maximum depth stops', () => {
    const origin = Array.from({ length: MAX_CHAIN_DEPTH }, (_, i) => `x${i}`)
    const res = evaluateRowEvent([stamp], changed({ task: 'a' }, { task: 'b' }, origin), ctx())
    expect(res.runs).toHaveLength(0)
    expect(res.skipped).toMatchObject([{ reason: 'depth' }])
  })

  it('the run budget cuts a rule off after its per-minute allowance and recovers with time', () => {
    let t = NOW
    const guard = createRunGuard({ now: () => t, perRulePerMinute: 3, totalPerMinute: 100 })
    const run = () => evaluateRowEvent([rule({ type: 'row_added' })], { kind: 'row_added', row: row('a', {}) }, ctx({ now: t }), guard)
    expect([run(), run(), run()].every((r) => r.runs.length === 1)).toBe(true)
    const over = run()
    expect(over.runs).toHaveLength(0)
    expect(over.skipped).toMatchObject([{ reason: 'throttled' }])
    t += 61_000
    expect(run().runs).toHaveLength(1)
  })

  it('the total budget applies across rules', () => {
    const guard = createRunGuard({ now: () => NOW, perRulePerMinute: 10, totalPerMinute: 2 })
    const rules = ['a', 'b', 'c'].map((id) => rule({ type: 'row_added' }, notify(), { id }))
    const res = evaluateRowEvent(rules, { kind: 'row_added', row: row('a', {}) }, ctx(), guard)
    expect(res.runs.map((r) => r.ruleId)).toEqual(['a', 'b'])
    expect(res.skipped.map((s) => s.ruleId)).toEqual(['c'])
  })
})

describe('time triggers', () => {
  const state = (over: Partial<{ lastRunAt: Record<string, number>; fired: Set<string> }> = {}) => ({ lastRunAt: {}, fired: new Set<string>(), ...over })
  const rows = [row('a', { task: 'A', due: '2026-11-19', owner: 'a@b.co' }), row('b', { task: 'B', due: '2026-11-20' }), row('c', { task: 'C', due: '2026-11-16' })]

  it('date: fires N days before / on / after the date, on that day only', () => {
    const before3 = rule({ type: 'date', columnId: 'due', when: 'before', days: 3 })
    expect(evaluateTick([before3], rows, ctx(), state()).runs.map((r) => r.rowId)).toEqual(['a']) // 19 - 3 = 16
    const on = rule({ type: 'date', columnId: 'due', when: 'on', days: 0 })
    expect(evaluateTick([on], rows, ctx(), state()).runs.map((r) => r.rowId)).toEqual(['c'])
    const after = rule({ type: 'date', columnId: 'due', when: 'after', days: 4 })
    expect(evaluateTick([after], [row('z', { due: '2026-11-12' })], ctx(), state()).runs.map((r) => r.rowId)).toEqual(['z'])
    expect(evaluateTick([before3], rows, ctx({ now: NOW + 2 * 86_400_000 }), state()).runs).toHaveLength(0)
  })

  it('date: fires once per row and date, however often it ticks', () => {
    const r = rule({ type: 'date', columnId: 'due', when: 'before', days: 3 })
    const first = evaluateTick([r], rows, ctx(), state())
    expect(first.runs).toHaveLength(1)
    const key = first.runs[0].dedupKey!
    expect(key).toContain('r1')
    expect(evaluateTick([r], rows, ctx({ now: NOW + 3_600_000 }), state({ fired: new Set([key]) })).runs).toHaveLength(0)
    // moving the date makes a new key
    const moved = [row('a', { task: 'A', due: '2026-11-19' }), row('a2', { task: 'A', due: '2026-11-19' })]
    expect(evaluateTick([r], moved, ctx(), state({ fired: new Set([key]) })).runs.map((x) => x.rowId)).toEqual(['a2'])
  })

  it('date: honours conditions and skips blank or invalid dates', () => {
    const conditions: ConditionGroup = { op: 'and', items: [{ columnId: 'status', op: 'is_not', value: 'Done' }] }
    const r = rule({ type: 'date', columnId: 'due', when: 'on', days: 0 }, notify(), { conditions })
    const list = [row('x', { due: '2026-11-16', status: 'Done' }), row('y', { due: '2026-11-16', status: 'Not started' }), row('z', { due: 'soon' }), row('w', {})]
    expect(evaluateTick([r], list, ctx(), state()).runs.map((x) => x.rowId)).toEqual(['y'])
  })

  it('schedule: finds the latest occurrence for daily, weekly, monthly (and the time zone)', () => {
    const t = (o: object) => ({ type: 'schedule' as const, frequency: 'daily' as const, time: '09:00', ...o })
    expect(new Date(latestOccurrence(t({}), NOW)!).toISOString()).toBe('2026-11-16T09:00:00.000Z')
    expect(new Date(latestOccurrence(t({ time: '11:00' }), NOW)!).toISOString()).toBe('2026-11-15T11:00:00.000Z')
    expect(new Date(latestOccurrence(t({ frequency: 'weekly', weekday: 5 }), NOW)!).toISOString()).toBe('2026-11-13T09:00:00.000Z') // last Friday
    expect(new Date(latestOccurrence(t({ frequency: 'weekly', weekday: 1 }), NOW)!).toISOString()).toBe('2026-11-16T09:00:00.000Z')
    expect(new Date(latestOccurrence(t({ frequency: 'monthly', dayOfMonth: 31 }), NOW)!).toISOString()).toBe('2026-10-31T09:00:00.000Z')
    expect(new Date(latestOccurrence(t({ frequency: 'monthly', dayOfMonth: 31 }), Date.UTC(2026, 1, 28, 12))!).toISOString()).toBe('2026-02-28T09:00:00.000Z') // short month clamps
    expect(new Date(latestOccurrence(t({ frequency: 'monthly', dayOfMonth: 20 }), Date.UTC(2027, 0, 5))!).toISOString()).toBe('2026-12-20T09:00:00.000Z')
    // 09:00 at UTC+2 is 07:00 UTC
    expect(new Date(latestOccurrence(t({}), NOW, 120)!).toISOString()).toBe('2026-11-16T07:00:00.000Z')
    expect(latestOccurrence(t({ time: '25:00' }), NOW)).toBeNull()
  })

  it('schedule: runs once per occurrence, for matching rows only, one digest per recipient', () => {
    const conditions: ConditionGroup = { op: 'and', items: [{ columnId: 'status', op: 'is_not', value: 'Done' }] }
    const r = rule(
      { type: 'schedule', frequency: 'daily', time: '09:00' },
      notify({ recipients: [{ kind: 'column', columnId: 'owner' }, { kind: 'owner' }] }),
      { conditions },
    )
    const list = [
      row('1', { task: 'One', status: 'In progress', owner: 'a@b.co' }),
      row('2', { task: 'Two', status: 'Not started', owner: 'a@b.co' }),
      row('3', { task: 'Three', status: 'Done', owner: 'a@b.co' }),
      row('4', { task: 'Four', status: 'In progress', owner: 'c@d.co' }),
    ]
    const res = evaluateTick([r], list, ctx(), state())
    expect(res.runs).toHaveLength(1)
    const run = res.runs[0]
    expect(run.rowId).toBeNull()
    expect(run.dedupKey).toBe(`r1:schedule:${Date.UTC(2026, 10, 16, 9)}`)
    const sent = run.actions.map((a) => (a.type === 'notify' ? [a.inApp, a.emails, a.items.map((i) => i.label)] : null))
    expect(sent).toEqual([
      [true, [], ['One', 'Two', 'Four']],
      [false, ['a@b.co'], ['One', 'Two']],
      [false, ['c@d.co'], ['Four']],
    ])
    // not again once recorded (by key, or because the last run is at/after the occurrence)
    expect(evaluateTick([r], list, ctx(), state({ fired: new Set([run.dedupKey!]) })).runs).toHaveLength(0)
    expect(evaluateTick([r], list, ctx(), state({ lastRunAt: { r1: NOW } })).runs).toHaveLength(0)
    // tomorrow's occurrence runs again
    expect(evaluateTick([r], list, ctx({ now: NOW + 86_400_000 }), state({ lastRunAt: { r1: NOW } })).runs).toHaveLength(1)
  })

  it('schedule: a new rule does not fire for occurrences before it existed, and does not catch up missed days', () => {
    const r = rule({ type: 'schedule', frequency: 'daily', time: '09:00' }, notify(), { createdAt: new Date(NOW - 3_600_000).toISOString() }) // created 09:00? no: 09:00 exactly
    // created at 09:00 sharp: the 09:00 occurrence is not after creation
    expect(evaluateTick([r], rows, ctx(), state()).runs).toHaveLength(0)
    const old = rule({ type: 'schedule', frequency: 'daily', time: '09:00' }, notify())
    // server was down for 5 days: ONE run, not five
    expect(evaluateTick([old], rows, ctx(), state({ lastRunAt: { r1: NOW - 5 * 86_400_000 } })).runs).toHaveLength(1)
  })

  it('schedule: when no row meets the conditions the run is recorded with a note', () => {
    const r = rule({ type: 'schedule', frequency: 'daily', time: '09:00' }, notify(), { conditions: { op: 'and', items: [{ columnId: 'status', op: 'is', value: 'Done' }] } })
    const res = evaluateTick([r], rows, ctx(), state())
    expect(res.runs[0].actions).toEqual([])
    expect(res.runs[0].notes).toEqual(['No row met the conditions'])
  })

  it('ticks are subject to the run budget', () => {
    const guard = createRunGuard({ now: () => NOW, totalPerMinute: 1 })
    const rules = [rule({ type: 'date', columnId: 'due', when: 'on', days: 0 }), rule({ type: 'date', columnId: 'due', when: 'on', days: 0 }, notify(), { id: 'r2' })]
    const res = evaluateTick(rules, rows, ctx(), state(), guard)
    expect(res.runs).toHaveLength(1)
    expect(res.skipped).toMatchObject([{ ruleId: 'r2', reason: 'throttled' }])
  })

  it('digest time: daily 08:00, weekly Monday 08:00 in the user time zone', () => {
    expect(new Date(nextDigestTime('daily', Date.UTC(2026, 10, 16, 7, 0))).toISOString()).toBe('2026-11-16T08:00:00.000Z')
    expect(new Date(nextDigestTime('weekly', Date.UTC(2026, 10, 16, 7, 0))).toISOString()).toBe('2026-11-16T08:00:00.000Z') // Monday morning, before 08:00
    expect(new Date(nextDigestTime('daily', NOW, 60)).toISOString()).toBe('2026-11-17T07:00:00.000Z') // 08:00 at UTC+1
  })
})

describe('digest batching', () => {
  const p = (id: string, over: Partial<PendingEmail> = {}): PendingEmail => ({
    id,
    ownerId: 'u1',
    recipientEmail: 'a@b.co',
    frequency: 'daily',
    subject: `Rule: ${id}`,
    body: `Row ${id} changed`,
    link: null,
    deliverAfter: NOW - 1000,
    ...over,
  })

  it('merges due digest items into one message per owner and recipient', () => {
    const out = batchDigests([p('1'), p('2'), p('3', { recipientEmail: 'c@d.co' }), p('4', { ownerId: 'u2' })], NOW)
    expect(out.map((o) => [o.ownerId, o.recipientEmail, o.ids])).toEqual([
      ['u1', 'a@b.co', ['1', '2']],
      ['u1', 'c@d.co', ['3']],
      ['u2', 'a@b.co', ['4']],
    ])
    expect(out[0].subject).toBe('2 updates')
    expect(out[0].text).toContain('Row 1 changed')
    expect(out[0].text).toContain('Row 2 changed')
    expect(out[1].subject).toBe('Rule: 3') // a single item is sent as it is
  })

  it('does not send what is not due yet, and never merges immediate notifications', () => {
    const out = batchDigests([p('1', { deliverAfter: NOW + 1 }), p('2', { frequency: 'immediately' }), p('3', { frequency: 'immediately' })], NOW)
    expect(out.map((o) => o.ids)).toEqual([['2'], ['3']])
  })

  it('caps the length of one digest', () => {
    const many = Array.from({ length: 60 }, (_, i) => p(String(i).padStart(3, '0')))
    const out = batchDigests(many, NOW)
    expect(out[0].ids).toHaveLength(60) // all are consumed...
    expect(out[0].text).toContain('...and 10 more.') // ...but only 50 are listed
  })

  it('a link is appended on its own line', () => {
    const out = batchDigests([p('1', { frequency: 'immediately', link: 'https://x/y' })], NOW)
    expect(out[0].text).toBe('Row 1 changed\n\nhttps://x/y')
  })
})

describe('dryRun and descriptions', () => {
  it('explains each condition and what the actions would be, without side effects', () => {
    const r = rule(
      { type: 'cell_becomes', columnId: 'status', value: 'Done' },
      notify(),
      { conditions: { op: 'and', items: [{ columnId: 'hours', op: 'gt', value: 5 }, { columnId: 'status', op: 'changed_to', value: 'Done' }] } },
    )
    const res = dryRun(r, row('a', { task: 'Slab', status: 'Done', hours: 8 }), ctx())
    expect(res.conditionsPass).toBe(true)
    expect(res.conditions).toEqual([
      { text: 'Hours is greater than "5"', pass: true },
      { text: 'Status changed to "Done"', pass: true },
    ])
    expect(res.run?.actions[0]).toMatchObject({ type: 'notify', inApp: true })
    const no = dryRun(r, row('a', { task: 'Slab', status: 'Done', hours: 2 }), ctx())
    expect(no.conditionsPass).toBe(false)
    expect(no.run).toBeNull()
    expect(no.conditions[0].pass).toBe(false)
  })

  it('a date rule is tested with the date as today and a cell_becomes rule starts from a blank cell', () => {
    const r = rule({ type: 'date', columnId: 'due', when: 'before', days: 2 }, notify(), { conditions: { op: 'and', items: [{ columnId: 'due', op: 'is_future' }] } })
    expect(dryRun(r, row('a', { due: '2026-12-01' }), ctx()).conditionsPass).toBe(true)
  })

  it('describes a rule in plain language', () => {
    const r = rule(
      { type: 'cell_becomes', columnId: 'status', value: 'Done' },
      notify({ recipients: [{ kind: 'column', columnId: 'owner' }], frequency: 'daily' }),
      { conditions: { op: 'and', items: [{ columnId: 'hours', op: 'gt', value: 5 }] } },
    )
    expect(describeRule(r, COLS)).toBe('When Status becomes Done, and Hours is greater than "5": notify the people in Owner in a daily digest.')
    expect(describeRule(rule({ type: 'schedule', frequency: 'weekly', weekday: 5, time: '09:00' }, { type: 'lock', locked: true }), COLS)).toBe('Every Friday at 09:00, for each row: lock the row.')
    expect(describeRule(rule({ type: 'date', columnId: 'due', when: 'before', days: 3 }, { type: 'record_date', columnId: 'doneOn' }), COLS)).toBe("When 3 days before the Due date: record today's date in Done on.")
  })
})
