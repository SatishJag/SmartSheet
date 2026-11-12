import type { Calendar } from '../engine/types'
import type { Column } from '../model/validate'
import { STATUS_OPTIONS, TRADE_OPTIONS } from './presets'

export type ColumnSpec = Omit<Column, 'id'>

export interface SheetTemplate {
  name: string
  description: string
  columns: ColumnSpec[]
  dependenciesEnabled: boolean
  calendar: Calendar
}

export const projectScheduleTemplate: SheetTemplate = {
  name: 'Project schedule',
  description: 'Phased task schedule with durations, predecessors, a Gantt chart and status tracking.',
  columns: [
    { title: 'Task', type: 'TEXT_NUMBER' },
    { title: 'Phase', type: 'TEXT_NUMBER' },
    { title: 'Trade', type: 'PICKLIST', options: [...TRADE_OPTIONS] },
    { title: 'Duration', type: 'DURATION', role: 'duration' },
    { title: 'Start', type: 'DATE', role: 'start' },
    { title: 'End', type: 'DATE', role: 'end' },
    { title: 'Predecessors', type: 'PREDECESSOR', role: 'predecessor' },
    { title: 'Status', type: 'PICKLIST', options: [...STATUS_OPTIONS], role: 'status' },
    { title: '% Complete', type: 'TEXT_NUMBER', role: 'percentComplete' },
  ],
  dependenciesEnabled: true,
  calendar: { workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [], hoursPerDay: 8 },
}
