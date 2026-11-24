/**
 * Projects as the planner offers them (see supabase/migrations/0022_projects.sql and
 * docs/superpowers/specs/2026-11-22-projects-design.md). Pure.
 */
import type { Project } from './types'

/** The project type whose plans carry cost codes and delivery sites. */
export const DATA_CENTRE = 'data-centre'

/** The projects listed under a project type, in the order given; all of them when none is chosen. */
export function projectsFor(projects: readonly Project[], projectType: string): Project[] {
  return projectType ? projects.filter((p) => p.projectType === projectType) : [...projects]
}

/** The dropdown text for a project, e.g. "BKK-03 — Bangkok 3" (the sheet stores this text). */
export const projectOption = (p: Project): string => `${p.code} — ${p.name}`

/**
 * How the wizard lists a project: as the sheet stores it, with "(new)" for a planner-added project not
 * yet found in Procore. The sheet never stores "(new)", so sheets do not change when it reaches Procore.
 */
export const projectListLabel = (p: Project): string => (p.addedByPlanner && !p.inProcore ? `${projectOption(p)} (new)` : projectOption(p))

/** The dropdown text for a project code, or undefined when that project is not on offer. */
export function optionForProject(projects: readonly Project[], code: string): string | undefined {
  const found = code ? projects.find((p) => p.code === code) : undefined
  return found ? projectOption(found) : undefined
}

/** The projects equipment can be delivered to: the sites, not the programs, in the order given. */
export const siteProjects = (projects: readonly Project[]): Project[] => projects.filter((p) => !p.isProgram)

/** An item's default delivery site: the plan's project when it is a site on offer, else ''. */
export function defaultDeliverySite(projects: readonly Project[], planProject: string): string {
  return planProject && siteProjects(projects).some((p) => p.code === planProject) ? planProject : ''
}
