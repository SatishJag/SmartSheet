import type { SheetData } from '../store/persistence'
import { punchListTemplate } from './punchList'
import { projectScheduleTemplate, type SheetTemplate } from './projectSchedule'

export type TemplateId = 'project-schedule' | 'punch-list'
export type { SheetTemplate } from './projectSchedule'
export { STATUS_OPTIONS, TRADE_OPTIONS } from './presets'
export { projectScheduleTemplate, punchListTemplate }

const BY_ID: Record<TemplateId, SheetTemplate> = {
  'project-schedule': projectScheduleTemplate,
  'punch-list': punchListTemplate,
}

export interface TemplateInfo {
  id: TemplateId
  name: string
  description: string
}

export const TEMPLATES: TemplateInfo[] = (Object.keys(BY_ID) as TemplateId[]).map((id) => ({
  id,
  name: BY_ID[id].name,
  description: BY_ID[id].description,
}))

/** A brand-new sheet from a template: fresh ids on every call, no rows, no dependencies. */
export function createSheetFromTemplate(templateId: TemplateId, ownerId: string): SheetData {
  const template = Object.prototype.hasOwnProperty.call(BY_ID, templateId) ? BY_ID[templateId] : undefined
  if (!template) throw new Error(`Unknown template: ${String(templateId)}`)
  return {
    sheet: {
      id: crypto.randomUUID(),
      name: template.name,
      ownerId,
      workspaceId: ownerId,
      calendar: {
        workingWeekdays: [...template.calendar.workingWeekdays],
        nonWorkingDates: [...template.calendar.nonWorkingDates],
        hoursPerDay: template.calendar.hoursPerDay,
      },
      dependenciesEnabled: template.dependenciesEnabled,
    },
    columns: template.columns.map((c) => ({
      ...c,
      ...(c.options ? { options: [...c.options] } : {}),
      id: crypto.randomUUID(),
    })),
    rows: [],
    dependencies: [],
  }
}
