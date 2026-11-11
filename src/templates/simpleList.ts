import { STATUS_OPTIONS } from './presets'
import type { SheetTemplate } from './projectSchedule'

/** The plain starting point (replaces the old column-less "Blank sheet"). */
export const simpleListTemplate: SheetTemplate = {
  name: 'Simple list',
  description: 'A plain list of tasks with a status and notes.',
  columns: [
    { title: 'Task', type: 'TEXT_NUMBER' },
    { title: 'Status', type: 'PICKLIST', options: [...STATUS_OPTIONS], role: 'status' },
    { title: 'Notes', type: 'TEXT_NUMBER' },
  ],
  dependenciesEnabled: false,
  calendar: { workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [], hoursPerDay: 8 },
}
