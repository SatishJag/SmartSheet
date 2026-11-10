import { STATUS_OPTIONS, TRADE_OPTIONS } from './presets'
import type { SheetTemplate } from './projectSchedule'

export const punchListTemplate: SheetTemplate = {
  name: 'Punch list',
  description: 'Closeout items with location, trade, assignee, status and due date.',
  columns: [
    { title: 'Item', type: 'TEXT_NUMBER' },
    { title: 'Location', type: 'TEXT_NUMBER' },
    { title: 'Trade', type: 'PICKLIST', options: [...TRADE_OPTIONS] },
    { title: 'Assigned To', type: 'CONTACT_LIST' },
    { title: 'Status', type: 'PICKLIST', options: [...STATUS_OPTIONS], role: 'status' },
    { title: 'Due Date', type: 'DATE' },
  ],
  dependenciesEnabled: false,
  calendar: { workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [], hoursPerDay: 8 },
}
