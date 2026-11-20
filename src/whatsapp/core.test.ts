import { describe, expect, it } from 'vitest'
import { MEENA, RAVI, WA_TODAY, WCOL, waSheet } from './__fixtures__/sheet'
import { chunkMessage, delayAlertMessage, detailMessage, listMessage, menuMessage, templateParam } from './format'
import { matchStatus, parseCommand, quickAnswer, splitComment } from './parse'
import { maskPhone, normalizePhone } from './phone'
import { atRisk, criticalOpen, delayed, delayedByOwner, dueWithin, menuCounts, milestones, onTrack, ownedBy } from './select'
import { findColumns, priorityOf, sheetFacts } from './tasks'
import { addDays, daysBetween, inQuietHours, localTime, minutesUntilQuietEnds } from './time'

const facts = () => sheetFacts(waSheet(), WA_TODAY)
const names = (ts: { name: string }[]) => ts.map((t) => t.name)

describe('sheet facts', () => {
  it('uses the planner schedule: dates, delay, float and the critical path', () => {
    const f = facts()
    expect(f.hasFloat).toBe(true)
    const slab = f.tasks.find((t) => t.rowId === 'r-slab')!
    expect(slab).toMatchObject({
      number: 3,
      parentName: 'Substructure',
      start: '2026-11-09',
      finish: '2026-11-13',
      percent: 40,
      complete: false,
      delayDays: 6,
      totalFloat: 0,
      critical: true,
      priority: 'HIGH',
      owners: [RAVI],
      department: 'Concrete',
      forecastFinish: '2026-11-22',
    })
    const rebar = f.tasks.find((t) => t.rowId === 'r-rebar')!
    expect(rebar).toMatchObject({ delayDays: 8, critical: false, priority: 'MEDIUM', owners: [MEENA] })
    expect(f.tasks.find((t) => t.rowId === 'r-top')).toMatchObject({ milestone: true, finish: '2026-11-27' })
    expect(f.tasks.find((t) => t.rowId === 'r-exc')).toMatchObject({ complete: true, delayDays: 0 })
    expect(f.work.map((t) => t.rowId)).not.toContain('r-sub')
  })

  it('without dependencies there is no float and priority defaults to MEDIUM', () => {
    const base = waSheet()
    const f = sheetFacts({ ...base, sheet: { ...base.sheet, dependenciesEnabled: false } }, WA_TODAY)
    expect(f.hasFloat).toBe(false)
    expect(f.work.every((t) => t.totalFloat === null && t.priority === 'MEDIUM' && !t.critical)).toBe(true)
    // Without dependencies the slab keeps its own start.
    expect(f.tasks.find((t) => t.rowId === 'r-col')!.start).toBe('2026-11-16')
  })

  it('treats a done status or 100% as complete, and ignores the owner when there is no contact column', () => {
    const base = waSheet()
    const rows = base.rows.map((r) => (r.id === 'r-rebar' ? { ...r, cells: { ...r.cells, [WCOL.percent]: 100 } } : r))
    const f = sheetFacts({ ...base, rows, columns: base.columns.filter((c) => c.id !== WCOL.owner) }, WA_TODAY)
    expect(f.tasks.find((t) => t.rowId === 'r-rebar')!.complete).toBe(true)
    expect(f.work.every((t) => t.owners.length === 0)).toBe(true)
  })

  it('finds the task-owner column by setting, then by title, then the first contact column', () => {
    const cols = [
      { id: 'a', title: 'Task', type: 'TEXT_NUMBER' as const },
      { id: 'b', title: 'Inspector', type: 'CONTACT_LIST' as const },
      { id: 'c', title: 'Assigned to', type: 'CONTACT_LIST' as const },
    ]
    expect(findColumns(cols).owner).toBe('c')
    expect(findColumns(cols, 'b').owner).toBe('b')
    expect(findColumns(cols, 'zzz').owner).toBe('c')
    expect(findColumns(cols.slice(0, 2)).owner).toBe('b')
  })

  it('maps float to priority like the WBS9 bot', () => {
    expect([priorityOf(0), priorityOf(1), priorityOf(14), priorityOf(15), priorityOf(null)]).toEqual(['HIGH', 'MEDIUM', 'MEDIUM', 'LOW', 'MEDIUM'])
  })
})

describe('menu lists', () => {
  it('selects delayed, due, at risk, on track, critical and milestones', () => {
    const w = facts().work
    expect(names(delayed(w))).toEqual(['Rebar delivery', 'Pour slab L1'])
    expect(names(dueWithin(w))).toEqual(['Facade mock-up', 'Columns L2', 'Topping out'])
    expect(names(atRisk(w))).toEqual(['Columns L2', 'Topping out'])
    expect(names(onTrack(w))).toEqual(['Facade mock-up'])
    expect(names(criticalOpen(w))).toEqual(['Pour slab L1', 'Columns L2', 'Topping out'])
    expect(names(milestones(w))).toEqual(['Topping out'])
    expect(names(ownedBy(w, 'RAVI@sub.example'))).toEqual(['Pour slab L1', 'Columns L2'])
    expect([...delayedByOwner(w).keys()].sort()).toEqual([MEENA, RAVI])
    expect(menuCounts(w)).toEqual({ total: 6, complete: 1, delayed: 2, due30: 3, onTrack: 1, atRisk: 2, critical: 3, criticalDelayed: 1, milestones: 1 })
  })
})

describe('messages', () => {
  it('numbers list entries and explains how to update', () => {
    const msg = listMessage('Delayed', delayed(facts().work), { canUpdate: true, empty: 'None' })
    expect(msg).toContain('*Delayed* (2)')
    expect(msg).toContain('*1.* Rebar delivery')
    expect(msg).toContain('*8 days late*')
    expect(msg).toContain('*2.* Pour slab L1')
    expect(msg).toContain('critical path')
    expect(msg).toContain('2 Complete')
    expect(listMessage('Delayed', [], { canUpdate: false, empty: 'Nothing is late.' })).toContain('Nothing is late.')
  })

  it('shows menu counts, and option 6 only to those who may send reminders', () => {
    const c = menuCounts(facts().work)
    expect(menuMessage('Tower A', c, { canNotifyOwners: true })).toContain('*6*')
    expect(menuMessage('Tower A', c, { canNotifyOwners: false })).not.toContain('*6*')
    expect(menuMessage('Tower A', c, { canNotifyOwners: false })).toContain('Delayed: 2')
  })

  it('details and delay alerts carry the facts that matter on site', () => {
    const slab = facts().tasks.find((t) => t.rowId === 'r-slab')!
    const d = detailMessage(slab, 'Tower A')
    expect(d).toContain('Forecast finish at this rate: 2026-11-22')
    expect(d).toContain('critical path')
    expect(delayAlertMessage(slab, 'Tower A', { toOwner: true })).toContain('Critical path task is late')
    expect(delayAlertMessage(slab, 'Tower A', { toOwner: false })).toContain(`Owner: ${RAVI}`)
  })

  it('splits long text at line breaks and flattens template parameters', () => {
    const long = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n')
    const parts = chunkMessage(long, 1000)
    expect(parts.length).toBeGreaterThan(5)
    expect(parts.every((p) => p.length <= 1000)).toBe(true)
    expect(parts.join('\n')).toBe(long)
    expect(templateParam('a\n\nb   c\tz')).toBe('a · b c z')
    expect(templateParam('y'.repeat(2000)).length).toBe(900)
  })
})

describe('parsing replies', () => {
  it('reads menu picks, details, updates, progress and codes', () => {
    expect(parseCommand('Hi!')).toEqual({ kind: 'menu' })
    expect(parseCommand('menu')).toEqual({ kind: 'menu' })
    expect(parseCommand(' 3 ')).toEqual({ kind: 'number', n: 3 })
    expect(parseCommand('#4')).toEqual({ kind: 'detail', n: 4 })
    expect(parseCommand('2 Complete')).toEqual({ kind: 'update', n: 2, status: 'Complete', percent: null, comment: '' })
    expect(parseCommand('2 in progress - waiting for steel')).toEqual({ kind: 'update', n: 2, status: 'in progress', percent: null, comment: 'waiting for steel' })
    expect(parseCommand('2 Delayed — crane down')).toEqual({ kind: 'update', n: 2, status: 'Delayed', percent: null, comment: 'crane down' })
    expect(parseCommand('5 60%')).toEqual({ kind: 'update', n: 5, status: null, percent: 60, comment: '' })
    expect(parseCommand('60% - slow deliveries')).toEqual({ kind: 'answer', status: null, percent: 60, comment: 'slow deliveries' })
    expect(parseCommand('link ab12cd34')).toEqual({ kind: 'link', code: 'AB12CD34' })
    expect(parseCommand('JOIN K9K9K9')).toEqual({ kind: 'join', code: 'K9K9K9' })
    expect(parseCommand('stop')).toEqual({ kind: 'stop' })
    expect(parseCommand('START')).toEqual({ kind: 'start' })
    expect(parseCommand('0')).toEqual({ kind: 'switch' })
    expect(parseCommand('email')).toEqual({ kind: 'email' })
    expect(parseCommand('what is late on the MEP works?')).toEqual({ kind: 'text', text: 'what is late on the MEP works?' })
    expect(parseCommand('Hi, which tasks are late?').kind).toBe('text')
  })

  it('keeps hyphenated words whole', () => {
    expect(splitComment('re-work needed')).toEqual({ head: 're-work needed', comment: '' })
    expect(splitComment('Delayed: rain')).toEqual({ head: 'Delayed', comment: 'rain' })
  })

  it('matches a status to the column’s options', () => {
    const opts = ['Not started', 'In progress', 'On hold', 'Complete']
    expect(matchStatus('complete', opts)).toBe('Complete')
    expect(matchStatus('done', opts)).toBe('Complete')
    expect(matchStatus('in prog', opts)).toBe('In progress')
    expect(matchStatus('on track', opts)).toBe('In progress')
    expect(matchStatus('blocked', opts)).toBe('On hold')
    expect(matchStatus('delayed', opts)).toBe('On hold')
    expect(matchStatus('not', opts)).toBe('Not started')
    expect(matchStatus('banana', opts)).toBeNull()
    expect(matchStatus('Snagging', undefined)).toBe('Snagging')
    expect(matchStatus('done', ['Open', 'Done'])).toBe('Done')
    expect(quickAnswer(3)).toBe('Complete')
    expect(quickAnswer(9)).toBeNull()
  })
})

describe('phones and time', () => {
  it('normalises international numbers', () => {
    expect(normalizePhone('+971 50 123 4567')).toBe('971501234567')
    expect(normalizePhone('00971501234567')).toBe('971501234567')
    expect(normalizePhone('(044) 12')).toBeNull()
    expect(normalizePhone('abc')).toBeNull()
    expect(maskPhone('971501234567')).toBe('+971 ••• 4567')
  })

  it('knows local time, quiet hours and day arithmetic', () => {
    const ms = Date.parse('2026-11-19T20:30:00Z')
    expect(localTime(ms, 'Asia/Dubai')).toEqual({ date: '2026-11-20', hour: 0, minute: 30 })
    expect(localTime(ms, 'Not/AZone')).toEqual({ date: '2026-11-19', hour: 20, minute: 30 })
    expect(inQuietHours({ hour: 23, minute: 0 }, '22:00', '07:00')).toBe(true)
    expect(inQuietHours({ hour: 6, minute: 59 }, '22:00', '07:00')).toBe(true)
    expect(inQuietHours({ hour: 7, minute: 0 }, '22:00', '07:00')).toBe(false)
    expect(inQuietHours({ hour: 13, minute: 0 }, '12:00', '14:00')).toBe(true)
    expect(inQuietHours({ hour: 13, minute: 0 }, '08:00', '08:00')).toBe(false)
    expect(minutesUntilQuietEnds({ hour: 23, minute: 0 }, '22:00', '07:00')).toBe(480)
    expect(daysBetween('2026-11-13', '2026-11-19')).toBe(6)
    expect(addDays('2026-11-30', 2)).toBe('2026-12-02')
  })
})
