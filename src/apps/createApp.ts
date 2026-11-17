import type { SupabaseClient } from '@supabase/supabase-js'
import { columnToDb, dependencyToDb, rowToDb, type SheetData } from '../store/persistence'
import { rmApi } from '../rm/api'
import type { Person } from '../rm/types'
import type { BuiltApp } from './build'

const ROW_CHUNK = 500

function check(res: { error: { message: string } | null }): void {
  if (res.error) throw new Error(res.error.message)
}

async function insertSheet(client: SupabaseClient, data: SheetData): Promise<void> {
  const { sheet } = data
  check(
    await client.from('sheets').insert({
      id: sheet.id,
      name: sheet.name,
      owner_id: sheet.ownerId,
      workspace_id: sheet.workspaceId,
      calendar: sheet.calendar,
      dependencies_enabled: sheet.dependenciesEnabled,
    }),
  )
  check(await client.from('columns').insert(data.columns.map((c, i) => columnToDb(c, i, sheet))))
  // Parents before children, so every parent_id already exists (also across chunks).
  const ordered = [...data.rows.filter((r) => r.parentId === null), ...data.rows.filter((r) => r.parentId !== null)]
  for (let i = 0; i < ordered.length; i += ROW_CHUNK) {
    check(await client.from('rows').insert(ordered.slice(i, i + ROW_CHUNK).map((r) => rowToDb(r, sheet))))
  }
  if (data.dependencies.length > 0) {
    check(await client.from('dependencies').insert(data.dependencies.map((d) => dependencyToDb(d, sheet, crypto.randomUUID()))))
  }
}

export interface CreatedApp {
  planSheetId: string
  projectId: string | null
}

/**
 * Writes a built app: every sheet (with rows and dependencies), then the Resource Management
 * project, placeholder people and assignments. All-or-nothing in effect: when a step fails, what
 * was already created is deleted (best effort) and the original error is thrown.
 */
export async function createApp(
  client: SupabaseClient,
  app: BuiltApp,
  existingPeople: readonly Person[],
  onProgress: (step: string) => void = () => {},
): Promise<CreatedApp> {
  const createdSheets: string[] = []
  const createdPeople: string[] = []
  let projectId: string | null = null
  const rm = rmApi(client)
  try {
    for (const s of app.sheets) {
      onProgress(`Creating ${s.sheet.name}`)
      await insertSheet(client, s)
      createdSheets.push(s.sheet.id)
    }
    if (app.resources) {
      onProgress('Setting up resource management')
      const byRole = new Map<string, string>()
      for (const p of existingPeople) if (p.member_type === 'placeholder' && p.role && !byRole.has(p.role)) byRole.set(p.role, p.id)
      for (const input of app.resources.newPeople) {
        const person = await rm.savePerson(input)
        createdPeople.push(person.id)
        byRole.set(input.role!, person.id)
      }
      const project = await rm.saveProject({ ...app.resources.project, sheet_id: app.planSheetId })
      projectId = project.id
      for (const { role, ...a } of app.resources.assignments) {
        const personId = byRole.get(role)
        if (!personId) throw new Error(`No person for role ${role}`)
        await rm.saveAssignment({ ...a, person_id: personId, project_id: project.id })
      }
    }
    return { planSheetId: app.planSheetId, projectId }
  } catch (err) {
    // Deleting the project and people cascades to their assignments; sheets cascade to rows.
    const undo = async () => {
      if (projectId) await client.from('rm_projects').delete().eq('id', projectId)
      for (const id of createdPeople) await client.from('rm_people').delete().eq('id', id)
      for (const id of createdSheets) await client.from('sheets').delete().eq('id', id)
    }
    try {
      await undo()
    } catch {
      // best effort; report the original failure
    }
    throw err
  }
}
