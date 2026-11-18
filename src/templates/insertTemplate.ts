import type { SupabaseClient } from '@supabase/supabase-js'
import { columnToDb, rowToDb, type SheetData } from '../store/persistence'
import { createSheetFromTemplate, type TemplateId } from './index'

const ROW_CHUNK = 500

/**
 * Inserts a new sheet with its columns and rows and returns the sheet id. If the columns or
 * rows cannot be inserted, the just-created sheet is deleted (best effort; the delete cascades)
 * so no partial sheet is left behind.
 */
export async function insertSheetData(client: SupabaseClient, data: SheetData): Promise<string> {
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
  let failure = colRes.error?.message
  for (let i = 0; !failure && i < data.rows.length; i += ROW_CHUNK) {
    const res = await client.from('rows').insert(data.rows.slice(i, i + ROW_CHUNK).map((r) => rowToDb(r, sheet)))
    failure = res.error?.message
  }
  if (failure) {
    try {
      await client.from('sheets').delete().eq('id', sheet.id)
    } catch {
      // best-effort cleanup; report the original failure
    }
    throw new Error(failure)
  }
  return sheet.id
}

/** Creates a sheet and all its columns from a template and returns the new sheet id. */
export async function insertSheetFromTemplate(client: SupabaseClient, templateId: TemplateId, userId: string): Promise<string> {
  return insertSheetData(client, createSheetFromTemplate(templateId, userId))
}
