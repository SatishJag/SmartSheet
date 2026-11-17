import { fullName, MEMBER_TYPE_LABELS, OFFICE_STATUS_LABELS, PROJECT_TYPE_LABELS, type Person, type Project } from './types'

/** A filter choice: '' means All. */
export type FilterState = Record<string, string>

export interface Facet<T> {
  key: string
  label: string
  /** The values a record has for this facet (several for tags). */
  values(item: T): string[]
  /** Display text for a value. */
  display?(value: string): string
}

const one = (v: string | null | undefined) => (v ? [v] : [])

export const PEOPLE_FACETS: Facet<Person>[] = [
  { key: 'memberType', label: 'Team Member', values: (p) => [p.member_type], display: (v) => MEMBER_TYPE_LABELS[v as Person['member_type']] ?? v },
  {
    key: 'officeStatus',
    label: 'Office Status',
    values: (p) => one(p.office_status),
    display: (v) => OFFICE_STATUS_LABELS[v as keyof typeof OFFICE_STATUS_LABELS] ?? v,
  },
  { key: 'discipline', label: 'Discipline', values: (p) => one(p.discipline) },
  { key: 'role', label: 'Role', values: (p) => one(p.role) },
  { key: 'location', label: 'Location', values: (p) => one(p.location) },
  { key: 'approver', label: 'Approver', values: (p) => [p.is_approver ? 'yes' : 'no'], display: (v) => (v === 'yes' ? 'Approvers' : 'Not approvers') },
  { key: 'tag', label: 'People Tags', values: (p) => p.tags },
]

export function projectFacets(people: ReadonlyMap<string, Person>): Facet<Project>[] {
  return [
    { key: 'state', label: 'Project State', values: (p) => [p.state], display: (v) => (v === 'active' ? 'Active' : 'Archived') },
    { key: 'type', label: 'Project Type', values: (p) => [p.project_type], display: (v) => PROJECT_TYPE_LABELS[v as Project['project_type']] ?? v },
    {
      key: 'owner',
      label: 'Project Owner',
      values: (p) => one(p.project_owner_id),
      display: (id) => {
        const person = people.get(id)
        return person ? fullName(person) : 'Unknown'
      },
    },
    { key: 'client', label: 'Client', values: (p) => one(p.client) },
    { key: 'tag', label: 'Tag', values: (p) => p.tags },
  ]
}

/** Distinct values of a facet across the records, sorted by display text. */
export function facetOptions<T>(facet: Facet<T>, items: readonly T[]): { value: string; label: string }[] {
  const seen = new Set<string>()
  for (const item of items) for (const v of facet.values(item)) seen.add(v)
  return [...seen]
    .map((value) => ({ value, label: facet.display?.(value) ?? value }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

export function applyFacets<T>(items: readonly T[], facets: readonly Facet<T>[], state: FilterState): T[] {
  const active = facets.filter((f) => state[f.key])
  if (active.length === 0) return [...items]
  return items.filter((item) => active.every((f) => f.values(item).includes(state[f.key])))
}

export type PersonSort = 'first' | 'last'

export function sortPeople(people: readonly Person[], by: PersonSort, descending = false): Person[] {
  const key = (p: Person) => (by === 'first' ? `${p.first_name} ${p.last_name}` : `${p.last_name} ${p.first_name}`).toLowerCase()
  const out = [...people].sort((a, b) => key(a).localeCompare(key(b)) || a.id.localeCompare(b.id))
  return descending ? out.reverse() : out
}

export function matchesSearch(text: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  return q === '' || text.toLowerCase().includes(q)
}

/** Text a person is searched by. */
export const personSearchText = (p: Person) =>
  [fullName(p), p.email, p.role, p.discipline, p.location, ...p.tags].filter(Boolean).join(' ')

export function parseTags(text: string): string[] {
  const out: string[] = []
  for (const part of text.split(',')) {
    const t = part.trim()
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}
