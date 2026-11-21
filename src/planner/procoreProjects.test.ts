import { describe, expect, it } from 'vitest'
import { optionForProject, projectOption } from './procoreProjects'
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
