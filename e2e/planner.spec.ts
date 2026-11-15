import { expect, test } from '@playwright/test'
import { defaultCalendar } from '../src/engine/calendar'
import { planBackward } from '../src/planner/backward'
import type { BatchPlanRequest, PlannerOptions, PlanRequest } from '../src/planner/types'
import { catalogDraft } from '../src/test/plannerFixtures'
import { ganttBar, gridCell, openTab, openApp } from './support/app'

const OPTIONS: PlannerOptions = {
  scheduleTypes: [{ id: 'lle-procurement', name: 'Long-lead equipment procurement', description: 'Procurement of long-lead equipment' }],
  equipmentTypes: { 'lle-procurement': ['Power transformer', 'Switchgear'] },
}

const TODAY = '2026-11-16' // a Monday
const REQUIRED = '2027-06-30' // too soon for a ~250-working-day plan: the preview must warn

test('Plan with AI: request, preview, approve into an editable schedule', async ({ page }) => {
  // The planning server is mocked; the browser's clock is pinned so the feasibility is known.
  await page.clock.setFixedTime(new Date(`${TODAY}T10:00:00`))
  const requests: PlanRequest[] = []
  let authorization = ''
  await page.route('**/api/planner/options', (route) => {
    authorization = route.request().headers().authorization ?? ''
    return route.fulfill({ json: OPTIONS })
  })
  await page.route('**/api/planner/draft', (route) => {
    const request = route.request().postDataJSON() as PlanRequest
    requests.push(request)
    return route.fulfill({ json: { ok: true, draft: { ...catalogDraft(request.requiredDate), request } } })
  })

  await openApp(page)
  await page.getByRole('button', { name: 'Plan with AI' }).click()
  const dialog = page.getByRole('dialog', { name: 'Plan with AI' })
  await expect(dialog.getByLabel('Schedule type')).toHaveValue('lle-procurement')
  expect(authorization).toMatch(/^Bearer fake-access-token-/)

  await dialog.getByLabel('Equipment type').selectOption('Power transformer')
  await dialog.getByLabel('Equipment name').fill('400 MVA transformer')
  await dialog.getByLabel('Required on site').fill(REQUIRED)
  await dialog.getByLabel('Notes (optional)').fill('Vendor in Korea; be conservative')
  await dialog.getByRole('button', { name: 'Generate' }).click()

  // Preview: activities with dates, the source, and the feasibility banner.
  const expected = planBackward(catalogDraft(REQUIRED), defaultCalendar, TODAY)
  const table = dialog.getByRole('table', { name: /Activities \(14\)/ })
  await expect(table).toBeVisible()
  expect(requests[0]).toMatchObject({ equipmentType: 'Power transformer', equipmentName: '400 MVA transformer', requiredDate: REQUIRED })
  await expect(dialog.getByText('Drafted by AI from 9 historical projects')).toBeVisible()
  await expect(dialog.getByRole('alert')).toContainText(
    `This plan should have started ${expected.feasibility.lateByWorkingDays} working days ago; the on-site date is at risk`,
  )
  const spec = table.getByRole('row', { name: /^Technical specification/ })
  await expect(spec).toContainText(expected.mustStartBy)
  const onsite = table.getByRole('row', { name: /^On site/ })
  await expect(onsite).toContainText('Milestone')
  await expect(onsite).toContainText(REQUIRED)
  await expect(table.getByRole('row', { name: /^Manufacturing / })).toContainText('Adjusted')

  // Approve: the new sheet opens with the activities, durations and predecessors.
  await dialog.getByRole('button', { name: 'Create schedule' }).click()
  await expect(page.getByRole('heading', { name: 'LLE – 400 MVA transformer' })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('grid')).toBeVisible()

  await expect(await gridCell(page, 1, 'Task')).toHaveText('Technical specification')
  await expect(await gridCell(page, 1, 'Duration')).toHaveText('10d')
  await expect(await gridCell(page, 1, 'Start')).toHaveText(expected.mustStartBy)
  await expect(await gridCell(page, 1, 'Basis')).toHaveText('p50 of 9 projects')
  await expect(await gridCell(page, 2, 'Predecessors')).toHaveText('1FS')
  await expect(await gridCell(page, 7, 'Task')).toHaveText('Raw material procurement')
  await expect(await gridCell(page, 7, 'Predecessors')).toHaveText('6SS +5d')
  await expect(await gridCell(page, 8, 'Task')).toHaveText('Manufacturing')
  await expect(await gridCell(page, 8, 'Duration')).toHaveText('120d')
  await expect(await gridCell(page, 8, 'Predecessors')).toHaveText('6FS, 7SS +15d')
  const mfg = expected.activities.find((a) => a.code === 'MFG')!
  await expect(await gridCell(page, 8, 'Start')).toHaveText(mfg.start)
  await expect(await gridCell(page, 8, 'End')).toHaveText(mfg.end)
  await expect(await gridCell(page, 8, 'Status')).toHaveText('Not started')

  // The Gantt draws a bar for every activity and the on-site milestone.
  await openTab(page, 'Gantt')
  for (const name of ['Technical specification', 'Manufacturing', 'Shipping']) await expect(ganttBar(page, name)).toBeVisible()
  await expect(ganttBar(page, 'On site')).toHaveAttribute('data-kind', 'milestone')
})

test('Plan with AI: several equipment items become one sheet with a summary row per item', async ({ page }) => {
  await page.clock.setFixedTime(new Date(`${TODAY}T10:00:00`))
  const batches: BatchPlanRequest[] = []
  const singles: PlanRequest[] = []
  await page.route('**/api/planner/options', (route) =>
    route.fulfill({
      json: { ...OPTIONS, projectCounts: { 'lle-procurement': { 'Power transformer': 8, Switchgear: 5 } } } satisfies PlannerOptions,
    }),
  )
  // The server answers each item with the catalog draft (the second one domestic: no customs step).
  await page.route('**/api/planner/draft-batch', (route) => {
    const batch = route.request().postDataJSON() as BatchPlanRequest
    batches.push(batch)
    const results = batch.items.map((item, i) => ({
      ok: true,
      draft: {
        ...catalogDraft(item.requiredDate, { domestic: i === 1 }),
        request: { scheduleType: batch.scheduleType, ...item, ...(batch.notes ? { notes: batch.notes } : {}) },
      },
    }))
    return route.fulfill({ json: { ok: true, results } })
  })
  await page.route('**/api/planner/draft', (route) => {
    singles.push(route.request().postDataJSON() as PlanRequest)
    return route.fulfill({ status: 500, json: { ok: false, error: 'the batch endpoint should be used' } })
  })

  await openApp(page)
  await page.getByRole('button', { name: 'Plan with AI' }).click()
  const dialog = page.getByRole('dialog', { name: 'Plan with AI' })
  await expect(dialog.getByLabel('Schedule type')).toHaveValue('lle-procurement')

  // Tick two equipment types: each adds an item.
  await dialog.getByRole('checkbox', { name: 'Power transformer · 8 projects' }).check()
  await dialog.getByRole('checkbox', { name: 'Switchgear · 5 projects' }).check()
  const first = dialog.getByRole('group', { name: 'Item 1' })
  const second = dialog.getByRole('group', { name: 'Item 2' })
  await expect(first.getByLabel('Equipment type')).toHaveValue('Power transformer')
  await expect(second.getByLabel('Equipment type')).toHaveValue('Switchgear')
  await first.getByLabel('Equipment name').fill('400 MVA transformer')
  await second.getByLabel('Equipment name').fill('132 kV GIS')
  // One shared date, and the switchgear needed earlier on its own date.
  await dialog.getByLabel('Required on site (all items)').fill('2028-03-31')
  await second.getByLabel('Required on site').fill(REQUIRED)
  await dialog.getByLabel('Notes for all items (optional)').fill('Vendors in Korea')
  await dialog.getByRole('button', { name: 'Generate' }).click()

  // The preview: an overall summary, then a section per item with its own banner and table.
  const transformer = planBackward(catalogDraft('2028-03-31'), defaultCalendar, TODAY)
  const switchgear = planBackward(catalogDraft(REQUIRED, { domestic: true }), defaultCalendar, TODAY)
  expect(switchgear.feasibility.feasible).toBe(false)
  expect(transformer.feasibility.feasible).toBe(true)
  await expect(
    dialog.getByText(`2 items · earliest required start ${switchgear.mustStartBy} · 1 item already late`),
  ).toBeVisible()
  expect(batches).toEqual([
    {
      scheduleType: 'lle-procurement',
      notes: 'Vendors in Korea',
      items: [
        { equipmentType: 'Power transformer', equipmentName: '400 MVA transformer', requiredDate: '2028-03-31' },
        { equipmentType: 'Switchgear', equipmentName: '132 kV GIS', requiredDate: REQUIRED },
      ],
    },
  ])
  expect(singles).toEqual([])
  const transformerHeader = dialog.getByRole('button', { name: /Power transformer — 400 MVA transformer/ })
  const switchgearHeader = dialog.getByRole('button', { name: /Switchgear — 132 kV GIS/ })
  await expect(transformerHeader).toContainText('On time')
  await expect(switchgearHeader).toContainText(`Late by ${switchgear.feasibility.lateByWorkingDays} working days`)
  await expect(dialog.getByRole('table')).toHaveCount(1) // the first item is open
  await switchgearHeader.click()
  await expect(dialog.getByRole('table')).toHaveCount(2)
  await expect(dialog.getByRole('alert')).toContainText(
    `This plan should have started ${switchgear.feasibility.lateByWorkingDays} working days ago`,
  )

  // Create schedule: one sheet, a parent row per item and its activities indented beneath.
  await dialog.getByRole('button', { name: 'Create schedule' }).click()
  await expect(page.getByRole('heading', { name: 'LLE plan – 2 items' })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('grid')).toBeVisible()

  const rowAt = (n: number) => page.getByRole('grid').getByRole('row').and(page.locator(`[aria-rowindex="${n + 1}"]`))
  await expect(await gridCell(page, 1, 'Task')).toContainText('Power transformer — 400 MVA transformer')
  await expect(rowAt(1)).toHaveAttribute('aria-level', '1')
  await expect(rowAt(1)).toHaveAttribute('aria-expanded', 'true')
  await expect(await gridCell(page, 2, 'Task')).toContainText('Technical specification')
  await expect(rowAt(2)).toHaveAttribute('aria-level', '2')
  // The summary row rolls up its item's dates; each item has its own required date.
  await expect(await gridCell(page, 1, 'Start')).toHaveText(transformer.mustStartBy)
  await expect(await gridCell(page, 1, 'End')).toHaveText(transformer.projectEnd)
  const mfg = transformer.activities.find((a) => a.code === 'MFG')!
  await expect(await gridCell(page, 9, 'Task')).toContainText('Manufacturing')
  await expect(await gridCell(page, 9, 'Start')).toHaveText(mfg.start)
  await expect(await gridCell(page, 9, 'Basis')).toHaveText('adjusted: p80 is 110 days; raised 10 days because the vendor is at capacity.')
  // Item 1 has 14 activities: rows 2 to 15; item 2's summary row is row 16 and its activities follow.
  await expect(await gridCell(page, 16, 'Task')).toContainText('Switchgear — 132 kV GIS')
  await expect(rowAt(16)).toHaveAttribute('aria-level', '1')
  await expect(await gridCell(page, 16, 'Start')).toHaveText(switchgear.mustStartBy)
  await expect(await gridCell(page, 16, 'End')).toHaveText(switchgear.projectEnd)
  await expect(await gridCell(page, 17, 'Task')).toContainText('Technical specification') // the same activity code as item 1
  await expect(rowAt(17)).toHaveAttribute('aria-level', '2')
  // Dependencies stay inside the item: item 2's second activity depends on ITS first (row 17), not item 1's.
  await expect(await gridCell(page, 18, 'Predecessors')).toHaveText('17FS')
  await expect(await gridCell(page, 3, 'Predecessors')).toHaveText('2FS')

  // The Gantt draws a summary bar per item and bars for activities of both.
  await openTab(page, 'Gantt')
  await expect(ganttBar(page, 'Power transformer — 400 MVA transformer')).toHaveAttribute('data-kind', 'summary')
  await expect(ganttBar(page, 'Switchgear — 132 kV GIS')).toHaveAttribute('data-kind', 'summary')
  await expect(ganttBar(page, 'Technical specification')).toHaveCount(2)
  await expect(ganttBar(page, 'Customs clearance')).toHaveCount(1) // only the imported transformer has it
})
