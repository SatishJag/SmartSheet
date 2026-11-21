/**
 * Procore projects as the planner offers them (see supabase/migrations/0020_procore_projects.sql and
 * the "Procore project" addendum of docs/superpowers/specs/2026-11-21-cost-code-link-design.md). Pure.
 */
import type { ProcoreProject } from './types'

/** The dropdown text for a project, e.g. "BKK-03 — Bangkok 3" (the sheet stores this text). */
export const projectOption = (p: ProcoreProject): string => `${p.code} — ${p.name}`

/** The dropdown text for a project code, or undefined when that project is not on offer. */
export function optionForProject(projects: readonly ProcoreProject[], code: string): string | undefined {
  const found = code ? projects.find((p) => p.code === code) : undefined
  return found ? projectOption(found) : undefined
}
