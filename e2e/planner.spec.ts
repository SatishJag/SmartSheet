import { expect, test } from '@playwright/test'
import { defaultCalendar } from '../src/engine/calendar'
import { planBackward } from '../src/planner/backward'
import type { BatchPlanRequest, PlannerOptions, PlanRequest } from '../src/planner/types'
import { catalogDraft } from '../src/test/plannerFixtures'
import { ganttBar, gridCell, openTab, openApp } from './support/app'

const OPTIONS: PlannerOptions = {
  projectTypes: [
    { id: 'data-centre', name: 'Data centre', description: 'Data halls' },
    { id: 'properties', name: 'Properties', description: 'Buildings' },
  ],
  scheduleTypes: [
    { id: 'lle-procurement', name: 'Long-lead equipment procurement', description: 'Procurement of long-lead equipment', projectTypes: ['data-centre', 'properties'] },
    { id: 'site-fitout', name: 'Fit-out', description: 'Only under properties', projectTypes: ['properties'] },
  ],
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
  // The project type comes first and narrows the schedule types on offer.
  await expect(dialog.getByLabel('Project type')).toHaveValue('data-centre')
  await expect(dialog.getByLabel('Schedule type')).toHaveValue('lle-procurement')
  await expect(dialog.getByLabel('Schedule type').locator('option')).toHaveText(['Long-lead equipment procurement'])
  await dialog.getByLabel('Project type').selectOption('properties')
  await expect(dialog.getByLabel('Schedule type').locator('option')).toHaveText(['Long-lead equipment procurement', 'Fit-out'])
  await dialog.getByLabel('Project type').selectOption('data-centre')
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
  // The AI is told the project type along with the user's notes.
  expect(requests[0].notes).toBe('Vendor in Korea; be conservative\nProject type: Data centre.')
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
      json: {
        ...OPTIONS,
        projectCounts: { 'lle-procurement': { 'Power transformer': 8, Switchgear: 5 } },
        procoreProjects: [{ code: 'BKK-03', name: 'Bangkok 3', isProgram: false }],
        costCodes: [
          { code: 'HVS', description: 'HV SiwtchGear', equipmentType: 'Switchgear' },
          { code: 'TRF', description: 'Transformer', equipmentType: 'Power transformer' },
        ],
      } satisfies PlannerOptions,
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
  // The plan is bought against one Procore project: none until the user picks one.
  await expect(dialog.getByLabel('Procore project')).toHaveValue('')
  await dialog.getByLabel('Procore project').selectOption('BKK-03')

  // Tick two equipment types: each adds an item.
  await dialog.getByRole('checkbox', { name: 'Power transformer · 8 projects' }).check()
  await dialog.getByRole('checkbox', { name: 'Switchgear · 5 projects' }).check()
  const first = dialog.getByRole('group', { name: 'Item 1' })
  const second = dialog.getByRole('group', { name: 'Item 2' })
  await expect(first.getByLabel('Equipment type')).toHaveValue('Power transformer')
  await expect(second.getByLabel('Equipment type')).toHaveValue('Switchgear')
  // Each item's Procore cost code is filled in from its type.
  await expect(first.getByLabel('Cost code')).toHaveValue('TRF')
  await expect(second.getByLabel('Cost code')).toHaveValue('HVS')
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
      notes: 'Vendors in Korea\nProject type: Data centre.',
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
  // The cost code sits on each item's summary row, not on its activities.
  await expect(await gridCell(page, 1, 'Procore project')).toHaveText('BKK-03 — Bangkok 3')
  await expect(await gridCell(page, 2, 'Procore project')).toHaveText('')
  await expect(await gridCell(page, 1, 'Cost code')).toHaveText('TRF — Transformer')
  await expect(await gridCell(page, 2, 'Cost code')).toHaveText('')
  await expect(await gridCell(page, 9, 'Basis')).toHaveText('adjusted: p80 is 110 days; raised 10 days because the vendor is at capacity.')
  // Item 1 has 14 activities: rows 2 to 15; item 2's summary row is row 16 and its activities follow.
  await expect(await gridCell(page, 16, 'Task')).toContainText('Switchgear — 132 kV GIS')
  await expect(rowAt(16)).toHaveAttribute('aria-level', '1')
  await expect(await gridCell(page, 16, 'Cost code')).toHaveText('HVS — HV SiwtchGear')
  await expect(await gridCell(page, 16, 'Procore project')).toHaveText('BKK-03 — Bangkok 3')
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

test('Plan with AI can be started from inside a sheet', async ({ page }) => {
  await page.route('**/api/planner/options', (route) => route.fulfill({ json: OPTIONS }))
  await openApp(page)
  await page.getByRole('button', { name: 'New sheet' }).click()
  await expect(page.getByRole('button', { name: 'Schedule settings' })).toBeVisible()
  await page.getByRole('button', { name: 'Plan with AI' }).click()
  await expect(page.getByRole('dialog', { name: 'Plan with AI' }).getByLabel('Project type')).toBeVisible()
})

test('Plan with AI on a phone: item rows with a Cost code field do not scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 })
  await page.route('**/api/planner/options', (route) =>
    route.fulfill({
      json: {
        ...OPTIONS,
        procoreProjects: [{ code: 'BKK-03', name: 'Bangkok 3', isProgram: false }],
        costCodes: [
          { code: 'HVS', description: 'HV SiwtchGear', equipmentType: 'Switchgear' },
          { code: 'TRF', description: 'Transformer', equipmentType: 'Power transformer' },
        ],
      } satisfies PlannerOptions,
    }),
  )
  await openApp(page)
  await page.getByRole('button', { name: 'Plan with AI' }).click()
  const dialog = page.getByRole('dialog', { name: 'Plan with AI' })
  await expect(dialog.getByLabel('Procore project')).toBeVisible()
  await dialog.getByRole('checkbox', { name: /^Power transformer/ }).check()
  await dialog.getByRole('checkbox', { name: /^Switchgear/ }).check()
  const first = dialog.getByRole('group', { name: 'Item 1' })
  await expect(first.getByLabel('Cost code')).toHaveValue('TRF')
  for (const group of [first, dialog.getByRole('group', { name: 'Item 2' })]) {
    const { scrollWidth, clientWidth } = await group.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }))
    expect(scrollWidth, 'item row content width vs row width').toBeLessThanOrEqual(clientWidth + 1)
  }
  const body = await dialog.locator('.planner-body').evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }))
  expect(body.scrollWidth, 'wizard body content width vs body width').toBeLessThanOrEqual(body.clientWidth + 1)
})

test('Plan with AI: the Procore project sits beside the schedule type, and below it on a phone', async ({ page }) => {
  await page.route('**/api/planner/options', (route) =>
    route.fulfill({ json: { ...OPTIONS, procoreProjects: [{ code: 'BKK-03', name: 'Bangkok 3', isProgram: false }] } satisfies PlannerOptions }),
  )
  await openApp(page)
  await page.getByRole('button', { name: 'Plan with AI' }).click()
  const dialog = page.getByRole('dialog', { name: 'Plan with AI' })
  const schedule = dialog.getByLabel('Schedule type')
  const project = dialog.getByLabel('Procore project')
  await expect(project).toBeVisible()
  const s = (await schedule.boundingBox())!
  const p = (await project.boundingBox())!
  expect(Math.abs(p.y - s.y), 'same row as the schedule type').toBeLessThan(2)
  expect(p.x, 'to the right of the schedule type').toBeGreaterThan(s.x + s.width)

  await page.setViewportSize({ width: 375, height: 800 })
  const s2 = (await schedule.boundingBox())!
  const p2 = (await project.boundingBox())!
  expect(p2.y, 'below the schedule type on a phone').toBeGreaterThan(s2.y + s2.height)
  const body = await dialog.locator('.planner-body').evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }))
  expect(body.scrollWidth).toBeLessThanOrEqual(body.clientWidth + 1)
})

test('Plan with AI: the top fields have room between them', async ({ page }) => {
  await page.route('**/api/planner/options', (route) =>
    route.fulfill({
      json: {
        ...OPTIONS,
        projectTypes: [{ id: 'data-centre', name: 'Data centre', description: 'Power, cooling and white-space fit-out for data halls.' }],
        procoreProjects: [{ code: 'BKK-03', name: 'Bangkok 3', isProgram: false }],
      } satisfies PlannerOptions,
    }),
  )
  await openApp(page)
  await page.getByRole('button', { name: 'Plan with AI' }).click()
  const dialog = page.getByRole('dialog', { name: 'Plan with AI' })
  const hint = (await dialog.getByText('Power, cooling and white-space fit-out for data halls.').boundingBox())!
  const label = (await dialog.locator('label', { hasText: 'Schedule type' }).boundingBox())!
  expect(label.y - (hint.y + hint.height), 'space between the project type hint and the schedule type label').toBeGreaterThanOrEqual(12)

  // On a phone the Procore project stacks under the schedule type, with room between them too.
  await page.setViewportSize({ width: 375, height: 800 })
  const scheduleHint = (await dialog.locator('.planner-schedule-type small').first().boundingBox())!
  const projectLabel = (await dialog.locator('label', { hasText: 'Procore project' }).boundingBox())!
  expect(projectLabel.y - (scheduleHint.y + scheduleHint.height), 'space between the schedule type hint and the Procore project label').toBeGreaterThanOrEqual(12)
})

test('Plan with AI: the equipment name stays wide enough to read beside the cost code, at any window width', async ({ page }) => {
  await page.route('**/api/planner/options', (route) =>
    route.fulfill({
      json: {
        ...OPTIONS,
        costCodes: [{ code: 'TRF', description: 'Transformer', equipmentType: 'Power transformer' }],
      } satisfies PlannerOptions,
    }),
  )
  await openApp(page)
  await page.getByRole('button', { name: 'Plan with AI' }).click()
  const dialog = page.getByRole('dialog', { name: 'Plan with AI' })
  await dialog.getByRole('checkbox', { name: /^Power transformer/ }).check()
  await dialog.getByRole('checkbox', { name: /^Switchgear/ }).check()
  const name = dialog.getByRole('group', { name: 'Item 1' }).getByLabel('Equipment name')
  for (const width of [861, 900, 960, 1000, 1040, 1100, 1280]) {
    await page.setViewportSize({ width, height: 800 })
    const box = (await name.boundingBox())!
    expect(box.width, `equipment name width at a ${width}px window`).toBeGreaterThanOrEqual(150)
  }
})
