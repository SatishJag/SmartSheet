import { describe, expect, it } from 'vitest'
import { defaultCalendar } from '../engine/calendar'
import { catalogDraft, makeDraft, activity } from '../test/plannerFixtures'
import { appendNote, batchRequestOf, overview, planRequestOf, readyEntry, type Entry, type Job } from './plannerEntries'

const TODAY = '2026-11-16'
const job: Job = {
  scheduleType: 'lle-procurement',
  notes: 'Shared',
  items: [
    { key: 'a', equipmentType: 'Power transformer', equipmentName: 'T1', requiredDate: '2028-03-31' },
    { key: 'b', equipmentType: 'Switchgear', equipmentName: 'S1', requiredDate: '2027-03-31', notes: 'Indoor' },
  ],
}

describe('requests from a job', () => {
  it('a single request has the shared notes, then the item\'s own', () => {
    expect(planRequestOf(job, job.items[0])).toEqual({
      scheduleType: 'lle-procurement',
      equipmentType: 'Power transformer',
      equipmentName: 'T1',
      requiredDate: '2028-03-31',
      notes: 'Shared',
    })
    expect(planRequestOf(job, job.items[1]).notes).toBe('Shared\nIndoor')
    expect(planRequestOf({ ...job, notes: undefined }, job.items[0])).not.toHaveProperty('notes')
  })

  it('the batch body drops client keys and keeps shared and per-item notes apart', () => {
    expect(batchRequestOf(job)).toEqual({
      scheduleType: 'lle-procurement',
      notes: 'Shared',
      items: [
        { equipmentType: 'Power transformer', equipmentName: 'T1', requiredDate: '2028-03-31' },
        { equipmentType: 'Switchgear', equipmentName: 'S1', requiredDate: '2027-03-31', notes: 'Indoor' },
      ],
    })
  })

  it('appendNote joins instructions with a line break', () => {
    expect(appendNote(undefined, 'a')).toBe('a')
    expect(appendNote('a', ' b ')).toBe('a\nb')
    expect(appendNote('a', '')).toBe('a')
  })
})

describe('readyEntry / overview', () => {
  const ready = (key: string, date: string, over = {}) => {
    const draft = { ...catalogDraft(date), ...over }
    return readyEntry(key, draft.request, draft, defaultCalendar, TODAY)
  }

  it('plans a draft to its date; an unschedulable draft throws a readable error', () => {
    const entry = ready('a', '2028-03-31')
    expect(entry).toMatchObject({ key: 'a', status: 'ready' })
    expect(entry.plan?.targetFinish).toBe('2028-03-31')
    const bad = makeDraft([activity('A', 1)], [], 'NOPE', '2028-03-31')
    expect(() => readyEntry('x', bad.request, bad, defaultCalendar, TODAY)).toThrow(/The draft could not be scheduled/)
  })

  it('summarises items, earliest start, late items and failures', () => {
    const onTime = ready('a', '2028-03-31')
    const late = ready('b', '2027-03-31')
    const failed: Entry = { key: 'c', status: 'failed', request: job.items[0] as never, error: 'boom' }
    const info = overview([onTime, late, failed])
    expect(info.items).toBe(3)
    expect(info.ready).toBe(2)
    expect(info.failed).toBe(1)
    expect(info.late).toBe(1)
    expect(info.earliestStart).toBe(late.plan!.mustStartBy)
    expect(info.text).toBe(`3 items · earliest required start ${late.plan!.mustStartBy} · 1 item already late · 1 item failed`)
  })

  it('says when no item is late, and counts sample-only items', () => {
    const sample = ready('a', '2030-03-31', { history: { ...catalogDraft().history, sampleOnly: true } })
    const other = ready('b', '2030-06-30')
    const info = overview([sample, other])
    expect(info.late).toBe(0)
    expect(info.sampleItems).toBe(1)
    expect(info.text).toBe(`2 items · earliest required start ${[sample, other].map((e) => e.plan!.mustStartBy).sort()[0]} · no item late`)
  })

  it('with nothing planned there is no start to report', () => {
    const failed: Entry = { key: 'c', status: 'failed', request: job.items[0] as never, error: 'x' }
    expect(overview([failed, failed]).text).toBe('2 items · 2 items failed')
  })
})
