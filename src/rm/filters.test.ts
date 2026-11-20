import { describe, expect, it } from 'vitest'
import { applyFacets, facetOptions, parseTags, PEOPLE_FACETS, sortPeople } from './filters'
import { blankPerson, type Person } from './types'

const person = (id: string, first: string, last: string, over: Partial<Person> = {}): Person => ({
  ...blankPerson(),
  id,
  first_name: first,
  last_name: last,
  ...over,
})

const people = [
  person('1', 'June', 'Taylor', { discipline: 'Electrical', tags: ['night', 'lead'] }),
  person('2', 'Hilda', 'Wilson', { discipline: 'Civil', member_type: 'contractor' }),
  person('3', 'Jamal', 'King', { discipline: 'Electrical', tags: ['lead'] }),
]

describe('people filters', () => {
  it('lists the distinct values of a facet', () => {
    const discipline = PEOPLE_FACETS.find((f) => f.key === 'discipline')!
    expect(facetOptions(discipline, people)).toEqual([
      { value: 'Civil', label: 'Civil' },
      { value: 'Electrical', label: 'Electrical' },
    ])
    const type = PEOPLE_FACETS.find((f) => f.key === 'memberType')!
    expect(facetOptions(type, people).map((o) => o.label)).toEqual(['Contractor', 'Employee'])
  })

  it('combines active facets and ignores empty ones', () => {
    expect(applyFacets(people, PEOPLE_FACETS, { discipline: 'Electrical', tag: 'night' }).map((p) => p.id)).toEqual(['1'])
    expect(applyFacets(people, PEOPLE_FACETS, { discipline: '', tag: 'lead' }).map((p) => p.id)).toEqual(['1', '3'])
    expect(applyFacets(people, PEOPLE_FACETS, {})).toHaveLength(3)
  })

  it('sorts by first or last name', () => {
    expect(sortPeople(people, 'first').map((p) => p.first_name)).toEqual(['Hilda', 'Jamal', 'June'])
    expect(sortPeople(people, 'last').map((p) => p.last_name)).toEqual(['King', 'Taylor', 'Wilson'])
    expect(sortPeople(people, 'first', true).map((p) => p.first_name)).toEqual(['June', 'Jamal', 'Hilda'])
  })

  it('parses comma-separated tags without blanks or repeats', () => {
    expect(parseTags(' a, b ,,a ')).toEqual(['a', 'b'])
  })
})
