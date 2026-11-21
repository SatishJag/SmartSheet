import { describe, expect, it } from 'vitest'
import { defaultDeliverySite, optionForProject, projectOption, siteProjects } from './procoreProjects'
import type { ProcoreProject } from './types'

const PROJECTS: ProcoreProject[] = [{ code: 'BKK-03', name: 'Bangkok 3', isProgram: false }]

describe('Procore projects', () => {
  it('formats an option as code, em dash, name', () => {
    expect(projectOption(PROJECTS[0])).toBe('BKK-03 — Bangkok 3')
  })

  it('finds the option text for a code, undefined when not offered', () => {
    expect(optionForProject(PROJECTS, 'BKK-03')).toBe('BKK-03 — Bangkok 3')
    expect(optionForProject(PROJECTS, 'XYZ')).toBeUndefined()
    expect(optionForProject(PROJECTS, '')).toBeUndefined()
  })
})

describe('delivery sites', () => {
  const ALL: ProcoreProject[] = [
    { code: 'PRG-DC-01', name: 'Data centre programme', isProgram: true },
    { code: 'BKK-03', name: 'Bangkok 3', isProgram: false },
    { code: 'SIN-01', name: 'Singapore 1', isProgram: false },
  ]

  it('offers the site projects, not the programs, in the order received', () => {
    expect(siteProjects(ALL).map((p) => p.code)).toEqual(['BKK-03', 'SIN-01'])
  })

  it('defaults to the plan’s project only when it is a site on offer', () => {
    expect(defaultDeliverySite(ALL, 'BKK-03')).toBe('BKK-03')
    expect(defaultDeliverySite(ALL, 'PRG-DC-01')).toBe('')
    expect(defaultDeliverySite(ALL, '')).toBe('')
    expect(defaultDeliverySite(ALL, 'XYZ')).toBe('')
  })
})
