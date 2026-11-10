import type { SupabaseClient } from '@supabase/supabase-js'
import { columnToDb } from '../store/persistence'
import { createSheetFromTemplate, type TemplateId } from './index'

/**
 * Creates a sheet and all its columns from a template and returns the new sheet id. If the
 * columns cannot be inserted, the just-created sheet is deleted (best effort) so no empty
 * sheet is left behind.
 */
export async function insertSheetFromTemplate(
  client: SupabaseClient,
  templateId: TemplateId,
  userId: string,
): Promise<string> {
  const data = createSheetFromTemplate(templateId, userId)
  const { sheet } = data

  const sheetRes = await client.from('sheets').insert({
    id: sheet.id,
    name: sheet.name,
    owner_id: sheet.ownerId,
    workspace_id: sheet.workspaceId,
    calendar: sheet.calendar,
    dependencies_enabled: sheet.dependenciesEnabled,
  })
  if (sheetRes.error) throw new Error(sheetRes.error.message)

  const colRes = await client.from('columns').insert(data.columns.map((c, i) => columnToDb(c, i, sheet)))
  if (colRes.error) {
    try {
      await client.from('sheets').delete().eq('id', sheet.id)
    } catch {
      // best-effort cleanup; report the original failure
    }
    throw new Error(colRes.error.message)
  }
  return sheet.id
}
