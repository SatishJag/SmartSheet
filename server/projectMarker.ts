import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Marks a project as in Procore (Sync with Procore found it there). `service` must be the service-role
 * client: planners cannot change projects (supabase/migrations/0024_planner_projects.sql).
 */
export function createProjectMarker(service: SupabaseClient): (code: string) => Promise<void> {
  return async (code) => {
    const { error } = await service.from('projects').update({ in_procore: true }).eq('code', code).eq('in_procore', false)
    if (error) throw new Error(error.message)
  }
}
