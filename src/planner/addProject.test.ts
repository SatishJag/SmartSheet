import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { addProject, checkNewProject, normaliseCode } from './addProject'
import { projectListLabel, projectOption } from './projects'

describe('normaliseCode', () => {
  it('trims and upper-cases what the planner typed', () => {
    expect(normaliseCode('  bkk-04 ')).toBe('BKK-04')
  })
})

describe('checkNewProject', () => {
  it('asks for both fields when empty', () => {
    expect(checkNewProject('', '  ')).toEqual({ code: 'Enter a code', name: 'Enter a name' })
  })

  it('accepts capitals, digits and hyphens up to 20, and a name up to 80 without commas', () => {
    expect(checkNewProject('BKK-04', 'Bangkok 4')).toEqual({})
    expect(checkNewProject('A'.repeat(20), 'N'.repeat(80))).toEqual({})
  })

  it.each(['BKK 04', '-BKK', 'BKK_04', 'bkk-04', 'A'.repeat(21)])('refuses the code %j', (code) => {
    expect(checkNewProject(code, 'Bangkok 4')).toEqual({ code: 'Use capitals, digits and hyphens (up to 20)' })
  })

  it('refuses a comma or more than 80 characters in the name', () => {
    expect(checkNewProject('BKK-04', 'Bangkok, 4')).toEqual({ name: 'A name cannot contain a comma' })
    expect(checkNewProject('BKK-04', 'N'.repeat(81))).toEqual({ name: 'A name can be up to 80 characters' })
  })
})

describe('projectListLabel', () => {
  const base = { code: 'BKK-04', name: 'Bangkok 4', isProgram: false, projectType: 'data-centre', inProcore: false }

  it('marks a planner-added project that is not in Procore yet as new', () => {
    expect(projectListLabel({ ...base, addedByPlanner: true })).toBe('BKK-04 — Bangkok 4 (new)')
  })

  it('shows other projects as the sheet stores them', () => {
    expect(projectListLabel(base)).toBe(projectOption(base))
    expect(projectListLabel({ ...base, addedByPlanner: true, inProcore: true })).toBe('BKK-04 — Bangkok 4')
  })
})

describe('addProject', () => {
  function client(result: { error: { message: string; code?: string } | null }) {
    const insert = vi.fn(async () => result)
    const from = vi.fn(() => ({ insert }))
    return { client: { from } as unknown as SupabaseClient, from, insert }
  }

  it('inserts the project as the planner, not in Procore, and returns it', async () => {
    const { client: c, from, insert } = client({ error: null })
    const out = await addProject(c, 'user-1', { code: ' bkk-04', name: ' Bangkok 4 ', projectType: 'data-centre' })
    expect(from).toHaveBeenCalledWith('projects')
    expect(insert).toHaveBeenCalledWith({
      code: 'BKK-04',
      name: 'Bangkok 4',
      project_type: 'data-centre',
      created_by: 'user-1',
      in_procore: false,
      is_program: false,
      in_planner: true,
    })
    expect(out).toEqual({
      ok: true,
      project: { code: 'BKK-04', name: 'Bangkok 4', isProgram: false, projectType: 'data-centre', inProcore: false, addedByPlanner: true },
    })
  })

  it('says when the code already exists', async () => {
    const { client: c } = client({ error: { message: 'duplicate key value violates unique constraint "projects_pkey"', code: '23505' } })
    expect(await addProject(c, 'user-1', { code: 'BKK-03', name: 'Again', projectType: 'data-centre' })).toEqual({ ok: false, error: 'BKK-03 already exists' })
  })

  it('passes on any other failure', async () => {
    const { client: c } = client({ error: { message: 'new row violates row-level security policy', code: '42501' } })
    expect(await addProject(c, 'user-1', { code: 'BKK-04', name: 'Bangkok 4', projectType: 'data-centre' })).toEqual({
      ok: false,
      error: 'Could not add the project: new row violates row-level security policy',
    })
  })

  it('checks the fields before asking the database', async () => {
    const { client: c, insert } = client({ error: null })
    expect(await addProject(c, 'user-1', { code: 'bkk 04', name: 'B', projectType: 'data-centre' })).toEqual({ ok: false, error: 'Use capitals, digits and hyphens (up to 20)' })
    expect(insert).not.toHaveBeenCalled()
  })

  it('reports a network failure', async () => {
    const insert = vi.fn(async () => {
      throw new Error('Failed to fetch')
    })
    const c = { from: () => ({ insert }) } as unknown as SupabaseClient
    expect(await addProject(c, 'user-1', { code: 'BKK-04', name: 'Bangkok 4', projectType: 'data-centre' })).toEqual({
      ok: false,
      error: 'Could not add the project: Failed to fetch',
    })
  })
})
