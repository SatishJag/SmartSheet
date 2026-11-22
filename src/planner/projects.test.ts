import { describe, expect, it } from 'vitest'
import { defaultDeliverySite, optionForProject, projectOption, projectsFor, siteProjects } from './projects'
import type { Project } from './types'

const PROJECTS: Project[] = [{ code: 'BKK-03', name: 'Bangkok 3', isProgram: false, projectType: 'data-centre', inProcore: true }]

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
  const ALL: Project[] = [
    { code: 'PRG-DC-01', name: 'Data centre programme', isProgram: true, projectType: 'data-centre', inProcore: true },
    { code: 'BKK-03', name: 'Bangkok 3', isProgram: false, projectType: 'data-centre', inProcore: true },
    { code: 'SIN-01', name: 'Singapore 1', isProgram: false, projectType: 'data-centre', inProcore: true },
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

describe('projects by project type', () => {
  const ALL: Project[] = [
    { code: 'PRG-DC-01', name: 'Data centre programme', isProgram: true, projectType: 'data-centre', inProcore: true },
    { code: 'BKK-03', name: 'Bangkok 3', isProgram: false, projectType: 'data-centre', inProcore: true },
    { code: 'SIN-01', name: 'Singapore 1', isProgram: false, projectType: 'data-centre', inProcore: true },
    { code: 'VIL-01', name: 'Sample villa', isProgram: false, projectType: 'properties', inProcore: false },
    { code: 'TWR-01', name: 'Sample tower', isProgram: false, projectType: 'properties', inProcore: false },
  ]

  it('lists the projects of one project type, in the order given', () => {
    expect(projectsFor(ALL, 'properties').map((p) => p.code)).toEqual(['VIL-01', 'TWR-01'])
    expect(projectsFor(ALL, 'data-centre').map((p) => p.code)).toEqual(['PRG-DC-01', 'BKK-03', 'SIN-01'])
  })

  it('lists every project when no project type is chosen', () => {
    expect(projectsFor(ALL, '')).toHaveLength(5)
  })
})
