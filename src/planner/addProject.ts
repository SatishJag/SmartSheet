/**
 * Adding a project from the wizard (docs/superpowers/specs/2026-11-23-new-project-design.md): any
 * planner can add one to the shared project list, as themselves and not in Procore (row-level
 * security in supabase/migrations/0024_planner_projects.sql enforces the same).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Project } from './types'

const CODE = /^[A-Z0-9][A-Z0-9-]*$/
const MAX_CODE = 20
const MAX_NAME = 80

/** The code as stored: trimmed and in capitals (the field upper-cases as the planner types). */
export const normaliseCode = (raw: string): string => raw.trim().toUpperCase()

/** What is wrong with a new project's fields, per field; empty when both are fine. */
export function checkNewProject(code: string, name: string): { code?: string; name?: string } {
  const problems: { code?: string; name?: string } = {}
  if (code === '') problems.code = 'Enter a code'
  else if (!CODE.test(code) || code.length > MAX_CODE) problems.code = 'Use capitals, digits and hyphens (up to 20)'
  const n = name.trim()
  if (n === '') problems.name = 'Enter a name'
  else if (n.includes(',')) problems.name = 'A name cannot contain a comma'
  else if (n.length > MAX_NAME) problems.name = `A name can be up to ${MAX_NAME} characters`
  return problems
}

/** Saves a planner's new project to the shared list. Nothing is saved when it fails. */
export async function addProject(
  client: SupabaseClient,
  userId: string,
  input: { code: string; name: string; projectType: string },
): Promise<{ ok: true; project: Project } | { ok: false; error: string }> {
  const code = normaliseCode(input.code)
  const name = input.name.trim()
  const problems = checkNewProject(code, name)
  const problem = problems.code ?? problems.name
  if (problem) return { ok: false, error: problem }
  let error: { message: string; code?: string } | null
  try {
    ;({ error } = await client
      .from('projects')
      .insert({ code, name, project_type: input.projectType, created_by: userId, in_procore: false, is_program: false, in_planner: true }))
  } catch (err) {
    error = { message: err instanceof Error ? err.message : String(err) }
  }
  if (error) return { ok: false, error: error.code === '23505' ? `${code} already exists` : `Could not add the project: ${error.message}` }
  return { ok: true, project: { code, name, isProgram: false, projectType: input.projectType, inProcore: false, addedByPlanner: true } }
}
