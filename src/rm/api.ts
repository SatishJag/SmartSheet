import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllPages } from '../store/paging'
import type { Assignment, AssignmentInput, Person, PersonInput, Project, ProjectInput, SavedView } from './types'

export interface RmData {
  people: Person[]
  projects: Project[]
  assignments: Assignment[]
  views: SavedView[]
}

type Table = 'rm_people' | 'rm_projects' | 'rm_assignments' | 'rm_views'

const num = (v: unknown) => (v === null || v === undefined ? v : Number(v))

// Postgres `numeric` arrives as a string from PostgREST; normalise to numbers.
const normPerson = (r: Person): Person => ({
  ...r,
  tags: r.tags ?? [],
  capacity_hours_per_day: Number(r.capacity_hours_per_day),
  bill_rate: Number(r.bill_rate),
})
const normProject = (r: Project): Project => ({
  ...r,
  tags: r.tags ?? [],
  budget_amount: num(r.budget_amount) as number | null,
  budget_days: num(r.budget_days) as number | null,
})
const normAssignment = (r: Assignment): Assignment => ({ ...r, allocation_percent: Number(r.allocation_percent) })

function fail(error: { message: string } | null, what: string): void {
  if (error) throw new Error(`Could not ${what}: ${error.message}`)
}

/** Thin, typed wrapper over the rm_* tables. Every call throws an Error on failure. */
export function rmApi(client: SupabaseClient) {
  const all = <T extends { id: string }>(table: Table) =>
    fetchAllPages<T>((from, to) => client.from(table).select('*').order('created_at').order('id').range(from, to))

  async function insert<T>(table: Table, values: object, what: string): Promise<T> {
    const { data, error } = await client.from(table).insert(values).select('*').single()
    fail(error, what)
    return data as T
  }
  async function update<T>(table: Table, id: string, patch: object, what: string): Promise<T> {
    const { data, error } = await client.from(table).update(patch).eq('id', id).select('*').single()
    fail(error, what)
    return data as T
  }
  async function remove(table: Table, id: string, what: string): Promise<void> {
    const { error } = await client.from(table).delete().eq('id', id)
    fail(error, what)
  }

  return {
    async loadAll(): Promise<RmData> {
      const [people, projects, assignments, views] = await Promise.all([
        all<Person>('rm_people'),
        all<Project>('rm_projects'),
        all<Assignment>('rm_assignments'),
        all<SavedView>('rm_views'),
      ])
      return {
        people: people.map(normPerson),
        projects: projects.map(normProject),
        assignments: assignments.map(normAssignment),
        views,
      }
    },
    async savePerson(input: PersonInput, id?: string) {
      return normPerson(
        id ? await update<Person>('rm_people', id, input, 'save the person') : await insert<Person>('rm_people', input, 'add the person'),
      )
    },
    deletePerson: (id: string) => remove('rm_people', id, 'delete the person'),
    async saveProject(input: ProjectInput, id?: string) {
      return normProject(
        id
          ? await update<Project>('rm_projects', id, input, 'save the project')
          : await insert<Project>('rm_projects', input, 'add the project'),
      )
    },
    deleteProject: (id: string) => remove('rm_projects', id, 'delete the project'),
    async saveAssignment(input: AssignmentInput, id?: string) {
      return normAssignment(
        id
          ? await update<Assignment>('rm_assignments', id, input, 'save the assignment')
          : await insert<Assignment>('rm_assignments', input, 'add the assignment'),
      )
    },
    deleteAssignment: (id: string) => remove('rm_assignments', id, 'delete the assignment'),
    saveView: (view: Omit<SavedView, 'id' | 'created_at'>) => insert<SavedView>('rm_views', view, 'save the view'),
    deleteView: (id: string) => remove('rm_views', id, 'delete the view'),
  }
}

export type RmApi = ReturnType<typeof rmApi>
