import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllPages } from '../store/paging'
import type { AssignmentInput, Person, ProjectInput } from './types'

const ISO = /^\d{4}-\d{2}-\d{2}$/

export interface SheetWork {
  /** Earliest start and latest end over the sheet's rows; null when no row has dates. */
  starts_at: string | null
  ends_at: string | null
  /** One per row that has dates and a contact who matches a person's email. */
  assignments: Omit<AssignmentInput, 'project_id'>[]
  /** Contact emails on dated rows that match nobody, for the summary. */
  unmatched: string[]
}

interface ColumnRow {
  id: string
  type: string
  role: string | null
}

/**
 * Reads the work in a sheet: its date span (Start / End role columns) and, for every row with a
 * contact (Contact List column) whose email matches a person, an assignment over that row's dates.
 */
export function extractSheetWork(columns: ColumnRow[], rows: { cells: Record<string, unknown> }[], people: Person[]): SheetWork {
  const startCol = columns.find((c) => c.role === 'start')?.id
  const endCol = columns.find((c) => c.role === 'end')?.id
  const contactCols = columns.filter((c) => c.type === 'CONTACT_LIST').map((c) => c.id)
  const byEmail = new Map(people.filter((p) => p.email).map((p) => [p.email!.toLowerCase(), p]))
  let min: string | null = null
  let max: string | null = null
  const assignments: SheetWork['assignments'] = []
  const unmatched = new Set<string>()
  for (const r of rows) {
    const s = startCol ? r.cells[startCol] : undefined
    const e = endCol ? r.cells[endCol] : undefined
    const start = typeof s === 'string' && ISO.test(s) ? s : null
    const end = typeof e === 'string' && ISO.test(e) ? e : start
    if (!start || !end) continue
    const [a, b] = start <= end ? [start, end] : [end, start]
    if (!min || a < min) min = a
    if (!max || b > max) max = b
    for (const col of contactCols) {
      const email = r.cells[col]
      if (typeof email !== 'string' || !email.trim()) continue
      const person = byEmail.get(email.trim().toLowerCase())
      if (!person) {
        unmatched.add(email.trim().toLowerCase())
        continue
      }
      assignments.push({ person_id: person.id, starts_at: a, ends_at: b, allocation_percent: 100, status: 'confirmed', notes: null })
    }
  }
  return { starts_at: min, ends_at: max, assignments, unmatched: [...unmatched].sort() }
}

export async function loadSheetWork(client: SupabaseClient, sheetId: string, people: Person[]): Promise<SheetWork> {
  const [columns, rows] = await Promise.all([
    fetchAllPages<ColumnRow>((from, to) => client.from('columns').select('id,type,role').eq('sheet_id', sheetId).order('id').range(from, to)),
    fetchAllPages<{ id: string; cells: Record<string, unknown> }>((from, to) =>
      client.from('rows').select('id,cells').eq('sheet_id', sheetId).order('id').range(from, to),
    ),
  ])
  return extractSheetWork(columns, rows, people)
}

export function projectFromSheet(name: string, sheetId: string, work: SheetWork, today: string): ProjectInput {
  return {
    name,
    client: null,
    project_type: 'confirmed',
    state: 'active',
    starts_at: work.starts_at ?? today,
    ends_at: work.ends_at ?? work.starts_at ?? today,
    project_owner_id: null,
    budget_type: 'none',
    budget_amount: null,
    budget_days: null,
    tags: [],
    sheet_id: sheetId,
  }
}
