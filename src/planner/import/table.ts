/**
 * Finds the activity table in an uploaded plan and copies its rows exactly: no AI here. Also reads the
 * "Basis of Plan" facts (project, handover date). (docs/superpowers/specs/2026-11-22-plan-import-design.md)
 */
import { isWorkingDay, workingDaysBetween } from '../../engine/calendar'
import type { Calendar, DepType } from '../../engine/types'
import type { Project } from '../types'
import { toIsoDate, type Workbook } from './workbook'

export const MAX_IMPORT_ACTIVITIES = 500
/** Rows scanned from the top of each sheet for a heading row. */
const HEADING_SCAN_ROWS = 30

export type ImportField =
  | 'activityId'
  | 'name'
  | 'phase'
  | 'kind'
  | 'responsibility'
  | 'duration'
  | 'start'
  | 'finish'
  | 'status'
  | 'predecessors'
  | 'criteria'

export interface TableMapping {
  sheet: string
  /** 0-based row of the headings; activities follow it. */
  headingRow: number
  fields: Partial<Record<ImportField, number>>
}

export interface ImportedLink {
  from: string
  type: DepType
  lagDays: number
}

export interface ImportedActivity {
  code: string
  name: string
  phase: string
  milestone: boolean
  responsibility?: string
  criteria?: string
  /** Working days; null when the file gives none (the server fills it). */
  durationDays: number | null
  /** 'file': a duration in the file; 'dates': worked out from its start and finish; null: none. */
  durationFrom: 'file' | 'dates' | null
  links: ImportedLink[]
  /** The file gave predecessors for this activity (even if some were left out). */
  hasPredecessors: boolean
  status: string
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** Known headings, normalized (lower case, punctuation as spaces). */
const SYNONYMS: Record<ImportField, string[]> = {
  activityId: ['activity id', 'id', 'code', 'activity code', 'task id', 'wbs code'],
  name: ['activity or milestone', 'activity', 'task', 'task name', 'activity name', 'description', 'name', 'milestone'],
  phase: ['stage wbs', 'stage', 'wbs', 'phase', 'stage phase'],
  kind: ['type', 'activity type', 'task type'],
  responsibility: ['lead responsibility', 'responsibility', 'owner', 'responsible', 'lead'],
  duration: ['duration days', 'duration', 'duration d', 'days', 'original duration'],
  start: ['baseline start', 'start', 'start date', 'planned start'],
  finish: ['baseline finish', 'finish', 'finish date', 'end', 'end date', 'planned finish'],
  status: ['status'],
  predecessors: ['reference predecessors', 'predecessors', 'predecessor', 'depends on', 'dependencies'],
  criteria: ['completion release criteria', 'criteria', 'completion criteria', 'acceptance criteria', 'release criteria'],
}

const FIELD_BY_HEADING = new Map<string, ImportField>(
  (Object.entries(SYNONYMS) as [ImportField, string[]][]).flatMap(([field, names]) => names.map((n) => [n, field] as [string, ImportField])),
)

function mapHeadings(row: string[]): Partial<Record<ImportField, number>> {
  const fields: Partial<Record<ImportField, number>> = {}
  row.forEach((cell, i) => {
    const field = FIELD_BY_HEADING.get(normalize(cell))
    if (field && fields[field] === undefined) fields[field] = i
  })
  return fields
}

/** The heading row of the activity table: `name` plus at least two other known columns. */
export function findActivityTable(wb: Workbook): TableMapping | null {
  let best: { map: TableMapping; score: number; rows: number } | null = null
  for (const sheet of wb.sheets) {
    const scan = Math.min(sheet.rows.length, HEADING_SCAN_ROWS)
    for (let r = 0; r < scan; r++) {
      const fields = mapHeadings(sheet.rows[r])
      const score = Object.keys(fields).length
      if (fields.name === undefined || score < 3) continue
      const rows = sheet.rows.length - r - 1
      if (!best || score > best.score || (score === best.score && rows > best.rows)) {
        best = { map: { sheet: sheet.name, headingRow: r, fields }, score, rows }
      }
    }
  }
  return best?.map ?? null
}

/**
 * `P080 FS; P090 SS+5; P100FF-2d; P010+5` → links ("Project start" and blanks → none). Lags in working
 * days. Given the file's IDs, an exact ID wins first, so IDs such as `HV-FF` or `P010-2` are not split.
 */
export function parsePredecessors(text: string, codes?: ReadonlySet<string>): ImportedLink[] {
  const links: ImportedLink[] = []
  for (const raw of text.split(/[;,]/)) {
    const token = raw.trim()
    if (!token || /^project start$/i.test(token)) continue
    if (codes) {
      const known = resolveWithCodes(token, codes)
      if (known) {
        links.push(known)
        continue
      }
    }
    const typed = /^(.+?)\s*(FS|SS|FF|SF)\s*(?:([+-])\s*(\d+))?\s*d?$/i.exec(token)
    if (typed) {
      const lag = typed[4] ? Number(typed[4]) * (typed[3] === '-' ? -1 : 1) : 0
      links.push({ from: typed[1].trim(), type: typed[2].toUpperCase() as DepType, lagDays: lag })
      continue
    }
    const lagged = /^(\S+)\s+([+-])\s*(\d+)\s*d?$/i.exec(token)
    if (lagged) {
      links.push({ from: lagged[1], type: 'FS', lagDays: Number(lagged[3]) * (lagged[2] === '-' ? -1 : 1) })
      continue
    }
    links.push({ from: token, type: 'FS', lagDays: 0 })
  }
  return links
}

/** A token read against the file's IDs: exact, `ID TYPE[±lag]` or `ID±lag`; null when no ID fits. */
function resolveWithCodes(token: string, codes: ReadonlySet<string>): ImportedLink | null {
  if (codes.has(token)) return { from: token, type: 'FS', lagDays: 0 }
  const typed = /^(.+?)\s*(FS|SS|FF|SF)\s*(?:([+-])\s*(\d+))?\s*d?$/i.exec(token)
  if (typed && codes.has(typed[1].trim())) {
    return { from: typed[1].trim(), type: typed[2].toUpperCase() as DepType, lagDays: typed[4] ? Number(typed[4]) * (typed[3] === '-' ? -1 : 1) : 0 }
  }
  const lagged = /^(.+?)\s*([+-])\s*(\d+)\s*d?$/i.exec(token)
  if (lagged && codes.has(lagged[1].trim())) return { from: lagged[1].trim(), type: 'FS', lagDays: Number(lagged[3]) * (lagged[2] === '-' ? -1 : 1) }
  return null
}

const STATUS_WORDS: Record<string, string> = {
  '': 'Not started',
  'to plan': 'Not started',
  'not started': 'Not started',
  planned: 'Not started',
  'to do': 'Not started',
  'in progress': 'In progress',
  started: 'In progress',
  ongoing: 'In progress',
  complete: 'Complete',
  completed: 'Complete',
  done: 'Complete',
  finished: 'Complete',
  'on hold': 'On hold',
}

/** A file status as one of the sheet's statuses (Not started, In progress, On hold, Complete). */
export function mapStatus(raw: string): { status: string; warning?: string } {
  const status = STATUS_WORDS[normalize(raw)]
  if (status) return { status }
  return { status: 'Not started', warning: `status "${raw.trim()}" is not one of the sheet’s statuses; it is set to Not started.` }
}

/** Working days from start to finish, both included. */
function inclusiveWorkingDays(cal: Calendar, start: string, finish: string): number {
  return workingDaysBetween(cal, start, finish) + (isWorkingDay(cal, start) ? 1 : 0)
}

/**
 * The activities under the heading row, copied exactly. Generates IDs (A001…) where none are given,
 * renames duplicate IDs (X1-2…), and leaves out links to codes not in the file or to the row itself,
 * each with a warning. Throws when the file has more than 500 activities.
 */
export function readActivities(wb: Workbook, map: TableMapping, cal: Calendar): { activities: ImportedActivity[]; warnings: string[] } {
  const sheet = wb.sheets.find((s) => s.name === map.sheet)
  if (!sheet) throw new Error(`The sheet "${map.sheet}" is not in the file`)
  const cell = (row: string[], field: ImportField) => {
    const i = map.fields[field]
    return i === undefined ? '' : (row[i] ?? '').trim()
  }
  const rows = sheet.rows.slice(map.headingRow + 1).filter((row) => cell(row, 'name') !== '')
  if (rows.length > MAX_IMPORT_ACTIVITIES) {
    throw new Error(`This file has ${rows.length} activities; the import takes up to ${MAX_IMPORT_ACTIVITIES}.`)
  }

  const warnings: string[] = []
  const codeOf = (row: string[], i: number) => cell(row, 'activityId') || `A${String(i + 1).padStart(3, '0')}`
  // Every code the file uses, so a renamed duplicate never takes a code another row already has.
  const taken = new Set(rows.map(codeOf))
  const used = new Set<string>()
  const activities = rows.map((row, i): ImportedActivity => {
    let code = codeOf(row, i)
    if (used.has(code)) {
      let n = 2
      while (taken.has(`${code}-${n}`) || used.has(`${code}-${n}`)) n++
      const renamed = `${code}-${n}`
      warnings.push(`${code} appears more than once; the later row is ${renamed}.`)
      code = renamed
    }
    used.add(code)

    const status = mapStatus(cell(row, 'status'))
    if (status.warning) warnings.push(`${code}: ${status.warning}`)
    const date = (field: 'start' | 'finish') => {
      const raw = cell(row, field)
      if (!raw) return null
      const iso = toIsoDate(raw)
      if (!iso) warnings.push(`${code}: the ${field} "${raw}" is not a date; it is ignored.`)
      return iso
    }
    const start = date('start')
    const finish = date('finish')

    const rawDuration = cell(row, 'duration').replace(/\s*d(ays)?$/i, '')
    // Kept as written: a quarter day stays 0.25 (only 0 makes a milestone).
    const given = /^\d+(\.\d+)?$/.test(rawDuration) ? Number(rawDuration) : null
    const milestone = /milestone/i.test(cell(row, 'kind')) || (given === 0 && !(start && finish && start !== finish))
    let durationDays: number | null = given
    let durationFrom: ImportedActivity['durationFrom'] = given === null ? null : 'file'
    if (milestone) {
      durationDays = 0
      durationFrom = 'file'
    } else if (given === null && start && finish && finish >= start) {
      const days = inclusiveWorkingDays(cal, start, finish)
      if (days > 0) {
        durationDays = days
        durationFrom = 'dates'
      }
    }

    const links = parsePredecessors(cell(row, 'predecessors'), taken)
    const responsibility = cell(row, 'responsibility')
    const criteria = cell(row, 'criteria')
    return {
      code,
      name: cell(row, 'name'),
      phase: cell(row, 'phase'),
      milestone,
      ...(responsibility ? { responsibility } : {}),
      ...(criteria ? { criteria } : {}),
      durationDays,
      durationFrom,
      links,
      hasPredecessors: links.length > 0,
      status: status.status,
    }
  })

  const codes = new Set(activities.map((a) => a.code))
  for (const a of activities) {
    a.links = a.links.filter((l) => {
      if (l.from === a.code) {
        warnings.push(`${a.code} refers to itself; that link is left out.`)
        return false
      }
      if (!codes.has(l.from)) {
        warnings.push(`${a.code} refers to ${l.from}, which is not in the file; that link is left out.`)
        return false
      }
      return true
    })
  }
  return { activities, warnings }
}

export interface BasisFacts {
  /** Values of project-labelled rows (name, code / location, ...), where a project code may appear. */
  projectText: string[]
  /** The last date in a handover-labelled value, as ISO; null when there is none. */
  handoverDate: string | null
}

const DATE_IN_TEXT = /\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}/g

/** Label/value facts from two-column sheets such as "Basis of Plan". */
export function readBasis(wb: Workbook): BasisFacts {
  const projectText: string[] = []
  let handoverDate: string | null = null
  for (const sheet of wb.sheets) {
    const filled = (row: string[]) => row.filter((c) => c.trim() !== '')
    if (sheet.rows.some((row) => filled(row).length > 3)) continue // a table, not label/value pairs
    for (const row of sheet.rows) {
      const [label, value] = filled(row)
      if (!label || !value) continue
      const key = normalize(label)
      if (key.includes('project')) projectText.push(value)
      if (key.includes('handover')) {
        const dates = (value.match(DATE_IN_TEXT) ?? []).map(toIsoDate).filter((d): d is string => d !== null)
        if (dates.length > 0) handoverDate = dates[dates.length - 1]
      }
    }
  }
  return { projectText, handoverDate }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A listed project whose code appears (as a whole word) in the basis, the file name or a sheet name; else ''. */
export function guessProject(projects: readonly Project[], wb: Workbook, basis: BasisFacts): string {
  const texts = [...basis.projectText, wb.fileName, ...wb.sheets.map((s) => s.name)]
  for (const text of texts) {
    for (const p of projects) {
      if (new RegExp(`(^|[^A-Za-z0-9])${escapeRe(p.code)}([^A-Za-z0-9]|$)`, 'i').test(text)) return p.code
    }
  }
  return ''
}
