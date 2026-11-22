import { describe, expect, it } from 'vitest'
import { defaultCalendar } from '../engine/calendar'
import { ALL_LABEL, FULL_PLAN_TYPES, NO_ITEM_TYPES, planCalendar, withFullPlanFirst } from './fullPlan'
import type { ScheduleType } from './types'

const t = (id: string, name = id): ScheduleType => ({ id, name, description: '' })

describe('fullPlan', () => {
  it('lists the full-plan types first, as All', () => {
    expect(ALL_LABEL).toBe('All (full project plan)')
    expect(FULL_PLAN_TYPES).toEqual(['dc-master', 'property-development'])
    expect(NO_ITEM_TYPES).toEqual(['dc-master'])
    const listed = withFullPlanFirst([t('lle-procurement', 'LLE'), t('dc-master', 'Data centre master schedule'), t('consultant-appointment', 'Consultants')])
    expect(listed.map((x) => [x.id, x.name])).toEqual([
      ['dc-master', 'All (full project plan)'],
      ['lle-procurement', 'LLE'],
      ['consultant-appointment', 'Consultants'],
    ])
    expect(withFullPlanFirst([t('materials-procurement'), t('property-development', 'Property development master schedule')]).map((x) => x.name)).toEqual([
      'All (full project plan)',
      'materials-procurement',
    ])
  })

  it('plans the Data centre master on a 7-day week', () => {
    expect(planCalendar('dc-master', defaultCalendar)).toEqual({ ...defaultCalendar, workingWeekdays: [0, 1, 2, 3, 4, 5, 6] })
    expect(planCalendar('lle-procurement', defaultCalendar)).toBe(defaultCalendar)
    expect(planCalendar('property-development', defaultCalendar)).toBe(defaultCalendar)
  })
})
