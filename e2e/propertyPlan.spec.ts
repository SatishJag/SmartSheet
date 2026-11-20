import { expect, test } from '@playwright/test'
import { withCatalogDetails } from '../server/planner'
import { PROPERTY_DEVELOPMENT_TYPE as T } from '../src/planner/catalogs/propertyDevelopment'
import { propertyDevelopmentCatalog as propertyCatalog } from '../src/planner/catalogs/propertyCatalog'
import { buildHistoryDraft } from '../src/planner/historyDraft'
import type { PlannerOptions, PlanRequest } from '../src/planner/types'
import { gridCell, openApp } from './support/app'

/**
 * Plan with AI with the Property department's template. The planning server is mocked: the draft is
 * the one the server builds from the template's catalog when there is no history (and copies the
 * template's activity id, responsibility and criteria onto), so the browser flow is the real one.
 */
const OPTIONS: PlannerOptions = {
  projectTypes: [
    { id: 'data-centre', name: 'Data centre', description: 'Data halls' },
    { id: 'properties', name: 'Properties', description: 'Buildings' },
  ],
  scheduleTypes: [
    { id: 'lle-procurement', name: 'Long-lead equipment procurement', description: 'LLE', projectTypes: ['data-centre', 'properties'] },
    { id: T.id, name: T.name, description: T.description, projectTypes: [...T.projectTypes], itemLabels: { ...T.itemLabels } },
  ],
  equipmentTypes: { 'lle-procurement': ['Power transformer'], [T.id]: [] },
}

test('Plan with AI drafts a property development master schedule from the department template', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-20T10:00:00'))
  const requests: PlanRequest[] = []
  await page.route('**/api/planner/options', (route) => route.fulfill({ json: OPTIONS }))
  await page.route('**/api/planner/draft', (route) => {
    const request = route.request().postDataJSON() as PlanRequest
    requests.push(request)
    const catalog = propertyCatalog()
    const history = { scheduleType: T.id, equipmentType: null, projectCount: 0, sampleOnly: false, stats: [] }
    const draft = withCatalogDetails(buildHistoryDraft({ request, catalog, history, assumptions: ['There is no history for this schedule type yet; durations are catalog defaults.'] }), catalog)
    return route.fulfill({ json: { ok: true, draft } })
  })

  await openApp(page)
  await page.getByRole('button', { name: 'Plan with AI' }).click()
  const dialog = page.getByRole('dialog', { name: 'Plan with AI' })
  await dialog.getByLabel('Project type').selectOption('properties')
  await dialog.getByLabel('Schedule type').selectOption(T.id)
  await expect(dialog.getByRole('heading', { name: 'Which development are you planning?' })).toBeVisible()
  await dialog.getByLabel('Development type').fill('Residential tower')
  await dialog.getByLabel('Development name').fill('Marina Heights, 2 towers, 450 units')
  await dialog.getByLabel('Planned handover').fill('2031-06-30')
  await page.screenshot({ path: 'test-results/property-plan-request.png' })
  await dialog.getByRole('button', { name: 'Generate' }).click()

  const table = dialog.getByRole('table', { name: /Activities \(44\)/ })
  await expect(table).toBeVisible()
  expect(requests[0]).toMatchObject({ scheduleType: T.id, equipmentType: 'Residential tower', requiredDate: '2031-06-30' })
  await expect(table.getByRole('row', { name: /^Complete planned handover/ })).toContainText('2031-06-30')
  await page.screenshot({ path: 'test-results/property-plan-preview.png' })

  await dialog.getByRole('button', { name: 'Create schedule' }).click()
  await expect(page.getByRole('heading', { name: 'Programme – Marina Heights, 2 towers, 450 units' })).toBeVisible()
  await expect(await gridCell(page, 1, 'Task')).toHaveText('Define development brief and feasibility')
  await expect(await gridCell(page, 1, 'Activity ID')).toHaveText('P010')
  await expect(await gridCell(page, 1, 'Phase')).toHaveText('01 Feasibility')
  await expect(await gridCell(page, 1, 'Start')).toHaveText('2028-02-01')
  await expect(await gridCell(page, 12, 'Task')).toHaveText('Obtain enabling and main works permits')
  await expect(await gridCell(page, 12, 'Lead responsibility')).toHaveText('Consultant / Authorities')
  await expect(await gridCell(page, 12, 'Predecessors')).toHaveText('9SS, 11FS')
  await page.screenshot({ path: 'test-results/property-plan-sheet.png' })
})
