import type { Calendar } from '../engine/types'
import { workingDayNumbers, type Assignment, type Resource, type TaskFact } from './engine'

/** Small builders shared by the resource tests. */
export const CAL: Calendar = { workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [], hoursPerDay: 8 }

export const person = (id: string, over: Partial<Resource> = {}): Resource => ({
  id,
  name: id,
  kind: 'person',
  department: null,
  skills: [],
  costRate: 0,
  hoursByWeekday: [0, 8, 8, 8, 8, 8, 0],
  timeOff: [],
  ...over,
})

export const task = (rowId: string, start: string, end: string, over: Partial<TaskFact> = {}): TaskFact => ({
  sheetId: 's1',
  rowId,
  name: `Task ${rowId}`,
  start,
  end,
  durationDays: workingDayNumbers(start, end, CAL).length,
  elapsed: false,
  calendar: CAL,
  totalFloat: 0,
  freeFloat: 0,
  critical: true,
  ...over,
})

export const assign = (id: string, resourceId: string, rowId: string, allocation: Assignment['allocation'], over: Partial<Assignment> = {}): Assignment => ({
  id,
  sheetId: 's1',
  rowId,
  resourceId,
  allocation,
  startDate: null,
  endDate: null,
  ...over,
})

