import { expect, test } from '@playwright/test'
import { defaultCalendar } from '../src/engine/calendar'
import { planBackward } from '../src/planner/backward'
import type { BatchPlanRequest, PlannerOptions, PlanRequest } from '../src/planner/types'
import { dcMasterCatalog } from '../src/planner/catalogs/dcMasterCatalog'
import { buildDcMasterDraft } from '../src/planner/dcMasterDraft'
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
        projects: [
          { code: 'PRG-DC-01', name: 'Data centre programme', isProgram: true, projectType: 'data-centre', inProcore: true },
          { code: 'BKK-03', name: 'Bangkok 3', isProgram: false, projectType: 'data-centre', inProcore: true },
        ],
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
  // The plan belongs to one project: none until the user picks one.
  await expect(dialog.getByLabel('Project', { exact: true })).toHaveValue('')
  await dialog.getByLabel('Project', { exact: true }).selectOption('BKK-03')

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
  // Bought against the site BKK-03, so both items are delivered there unless changed.
  await expect(first.getByLabel('Delivery site')).toHaveValue('BKK-03')
  await expect(second.getByLabel('Delivery site')).toHaveValue('BKK-03')
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
  await expect(await gridCell(page, 1, 'Project')).toHaveText('BKK-03 — Bangkok 3')
  await expect(await gridCell(page, 2, 'Project')).toHaveText('')
  await expect(await gridCell(page, 1, 'Cost code')).toHaveText('TRF — Transformer')
  await expect(await gridCell(page, 2, 'Cost code')).toHaveText('')
  await expect(await gridCell(page, 9, 'Basis')).toHaveText('adjusted: p80 is 110 days; raised 10 days because the vendor is at capacity.')
  // Item 1 has 14 activities: rows 2 to 15; item 2's summary row is row 16 and its activities follow.
  await expect(await gridCell(page, 16, 'Task')).toContainText('Switchgear — 132 kV GIS')
  await expect(rowAt(16)).toHaveAttribute('aria-level', '1')
  await expect(await gridCell(page, 16, 'Cost code')).toHaveText('HVS — HV SiwtchGear')
  await expect(await gridCell(page, 16, 'Project')).toHaveText('BKK-03 — Bangkok 3')
  // The delivery site is on every row of each item, so the site team's filter keeps whole items.
  for (const row of [1, 2, 16, 17]) await expect(await gridCell(page, row, 'Delivery site')).toHaveText('BKK-03 — Bangkok 3')
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
        projects: [{ code: 'BKK-03', name: 'Bangkok 3', isProgram: false, projectType: 'data-centre', inProcore: true }],
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
  await expect(dialog.getByLabel('Project', { exact: true })).toBeVisible()
  await expect(dialog.getByLabel('Delivery site').first()).toBeVisible()
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

test('Plan with AI: the project sits beside the schedule type, and below it on a phone', async ({ page }) => {
  await page.route('**/api/planner/options', (route) =>
    route.fulfill({ json: { ...OPTIONS, projects: [{ code: 'BKK-03', name: 'Bangkok 3', isProgram: false, projectType: 'data-centre', inProcore: true }] } satisfies PlannerOptions }),
  )
  await openApp(page)
  await page.getByRole('button', { name: 'Plan with AI' }).click()
  const dialog = page.getByRole('dialog', { name: 'Plan with AI' })
  const schedule = dialog.getByLabel('Schedule type')
  const project = dialog.getByLabel('Project', { exact: true })
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
        projects: [{ code: 'BKK-03', name: 'Bangkok 3', isProgram: false, projectType: 'data-centre', inProcore: true }],
      } satisfies PlannerOptions,
    }),
  )
  await openApp(page)
  await page.getByRole('button', { name: 'Plan with AI' }).click()
  const dialog = page.getByRole('dialog', { name: 'Plan with AI' })
  const hint = (await dialog.getByText('Power, cooling and white-space fit-out for data halls.').boundingBox())!
  const label = (await dialog.locator('label', { hasText: 'Schedule type' }).boundingBox())!
  expect(label.y - (hint.y + hint.height), 'space between the project type hint and the schedule type label').toBeGreaterThanOrEqual(12)

  // On a phone the project stacks under the schedule type, with room between them too.
  await page.setViewportSize({ width: 375, height: 800 })
  const scheduleHint = (await dialog.locator('.planner-schedule-type small').first().boundingBox())!
  const projectLabel = (await dialog.locator('label', { hasText: /^Project$/ }).boundingBox())!
  expect(projectLabel.y - (scheduleHint.y + scheduleHint.height), 'space between the schedule type hint and the project label').toBeGreaterThanOrEqual(12)
})

test('Plan with AI: the equipment name stays wide enough to read beside the cost code, at any window width', async ({ page }) => {
  await page.route('**/api/planner/options', (route) =>
    route.fulfill({
      json: {
        ...OPTIONS,
        costCodes: [{ code: 'TRF', description: 'Transformer', equipmentType: 'Power transformer' }],
        projects: [{ code: 'BKK-03', name: 'Bangkok 3', isProgram: false, projectType: 'data-centre', inProcore: true }],
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
    // Cost code and Delivery site sit on the item's second line.
    const site = (await dialog.getByRole('group', { name: 'Item 1' }).getByLabel('Delivery site').boundingBox())!
    expect(site.y, `delivery site below the name at a ${width}px window`).toBeGreaterThan(box.y + box.height)
  }
})

test('Plan with AI: an item row without cost codes or sites stays on one line', async ({ page }) => {
  await page.route('**/api/planner/options', (route) => route.fulfill({ json: OPTIONS }))
  await openApp(page)
  await page.getByRole('button', { name: 'Plan with AI' }).click()
  const dialog = page.getByRole('dialog', { name: 'Plan with AI' })
  await dialog.getByRole('checkbox', { name: /^Power transformer/ }).check()
  await dialog.getByRole('checkbox', { name: /^Switchgear/ }).check()
  const group = dialog.getByRole('group', { name: 'Item 1' })
  const row = (await group.boundingBox())!
  const date = (await group.getByLabel('Required on site').boundingBox())!
  // Below the date there is only its hint and the row's padding: no second line.
  expect(row.y + row.height - (date.y + date.height), 'row space below the date field').toBeLessThan(45)
  await expect(group.locator('.planner-item-tags')).toHaveCount(0)
})

test('Plan with AI: a property plan needs a project, from the sample property projects', async ({ page }) => {
  await page.clock.setFixedTime(new Date(`${TODAY}T10:00:00`))
  await page.route('**/api/planner/options', (route) =>
    route.fulfill({
      json: {
        ...OPTIONS,
        projectTypes: [
          { id: 'data-centre', name: 'Data centre', description: 'Halls' },
          { id: 'properties', name: 'Properties', description: 'Villas and towers' },
        ],
        scheduleTypes: OPTIONS.scheduleTypes.map((t) => ({ ...t, projectTypes: ['data-centre', 'properties'] })),
        costCodes: [{ code: 'TRF', description: 'Transformer', equipmentType: 'Power transformer' }],
        projects: [
          { code: 'BKK-03', name: 'Bangkok 3', isProgram: false, projectType: 'data-centre', inProcore: true },
          { code: 'VIL-01', name: 'Sample villa', isProgram: false, projectType: 'properties', inProcore: false },
          { code: 'TWR-01', name: 'Sample tower', isProgram: false, projectType: 'properties', inProcore: false },
        ],
      } satisfies PlannerOptions,
    }),
  )
  await page.route('**/api/planner/draft', (route) => {
    const request = route.request().postDataJSON() as PlanRequest
    return route.fulfill({ json: { ok: true, draft: { ...catalogDraft(request.requiredDate), request } } })
  })
  await openApp(page)
  await page.getByRole('button', { name: 'Plan with AI' }).click()
  const dialog = page.getByRole('dialog', { name: 'Plan with AI' })
  await dialog.getByLabel('Project type').selectOption('properties')
  const project = dialog.getByLabel('Project', { exact: true })
  await expect(project.locator('option')).toHaveText(['Choose a project…', 'VIL-01 — Sample villa', 'TWR-01 — Sample tower'])
  await expect(dialog.getByLabel('Cost code')).toHaveCount(0)
  await dialog.getByLabel('Equipment name').fill('Lift for tower A')
  await dialog.getByLabel('Required on site').fill(REQUIRED)
  await dialog.getByRole('button', { name: 'Generate' }).click()
  await expect(dialog.getByRole('alert')).toContainText('Choose the project')
  await project.selectOption('VIL-01')
  await dialog.getByRole('button', { name: 'Generate' }).click()
  await expect(dialog.getByRole('table')).toBeVisible()
})

test('Plan with AI: import a plan from Excel, confirm what was found, and create it', async ({ page }) => {
  await page.clock.setFixedTime(new Date(`${TODAY}T10:00:00`))
  const imports: unknown[] = []
  await page.route('**/api/planner/options', (route) =>
    route.fulfill({
      json: {
        ...OPTIONS,
        projectTypes: [
          { id: 'data-centre', name: 'Data centre', description: 'Halls' },
          { id: 'properties', name: 'Properties', description: 'Villas and towers' },
        ],
        scheduleTypes: [
          ...OPTIONS.scheduleTypes.map((t) => ({ ...t, projectTypes: ['data-centre', 'properties'] })),
          { id: 'property-development', name: 'Property development master schedule', description: 'Property', projectTypes: ['properties'] },
        ],
        projects: [
          { code: 'BKK-03', name: 'Bangkok 3', isProgram: false, projectType: 'data-centre', inProcore: true },
          { code: 'VIL-01', name: 'Sample villa', isProgram: false, projectType: 'properties', inProcore: false },
        ],
      } satisfies PlannerOptions,
    }),
  )
  await page.route('**/api/planner/import', (route) => {
    imports.push(route.request().postDataJSON())
    return route.fulfill({
      json: {
        ok: true,
        scheduleType: 'property-development',
        targetCode: 'P420',
        durations: [{ code: 'P035', days: 12, basis: 'estimate', reason: 'Similar to a site survey.' }],
        templateLinks: [],
        history: { scheduleType: 'property-development', equipmentType: null, projectCount: 0, sampleOnly: false, stats: [] },
      },
    })
  })
  await openApp(page)
  await page.getByRole('button', { name: 'Plan with AI' }).click()
  const dialog = page.getByRole('dialog', { name: 'Plan with AI' })
  await expect(dialog.getByRole('button', { name: 'Import from Excel', exact: true })).toBeVisible()
  await dialog.getByLabel('Import from Excel file').setInputFiles('src/planner/import/__fixtures__/plan-template.xlsx')

  await expect(dialog.getByRole('heading', { name: 'What we found' })).toBeVisible()
  await expect(dialog.getByText('6 activities: 5 durations from your file, 1 filled in')).toBeVisible()
  await expect(dialog.getByLabel('Project', { exact: true })).toHaveValue('VIL-01')
  await expect(dialog.getByLabel('Planned handover')).toHaveValue('2028-06-30')
  expect(imports).toHaveLength(1)
  // Schedule type and Project share a row.
  const typeBox = (await dialog.getByLabel('Schedule type').boundingBox())!
  const projectBox = (await dialog.getByLabel('Project', { exact: true }).boundingBox())!
  expect(Math.abs(typeBox.y - projectBox.y)).toBeLessThan(2)

  await dialog.getByRole('button', { name: 'Preview' }).click()
  await expect(dialog.getByRole('button', { name: /Regenerate/ })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Create schedule' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('grid')).toBeVisible()
  await expect(await gridCell(page, 1, 'Activity ID')).toHaveText('P010')
  await expect(await gridCell(page, 1, 'Basis')).toHaveText('from your file')
  await expect(await gridCell(page, 3, 'Status')).toContainText('In progress')
  await expect(await gridCell(page, 4, 'Basis')).toHaveText('AI estimate: Similar to a site survey.')
})

test('Sync with Procore fills Committed and Awarded', async ({ page }) => {
  await page.clock.setFixedTime(new Date(`${TODAY}T10:00:00`))
  await page.route('**/api/planner/options', (route) =>
    route.fulfill({
      json: {
        ...OPTIONS,
        projects: [{ code: 'BKK-03', name: 'Bangkok 3', isProgram: false, projectType: 'data-centre', inProcore: true }],
        costCodes: [{ code: 'TRF', description: 'Transformer', equipmentType: 'Power transformer' }],
      } satisfies PlannerOptions,
    }),
  )
  await page.route('**/api/planner/draft', (route) => {
    const request = route.request().postDataJSON() as PlanRequest
    return route.fulfill({ json: { ok: true, draft: { ...catalogDraft(request.requiredDate), request } } })
  })
  const syncRequests: unknown[] = []
  await page.route('**/api/procore/committed', (route) => {
    syncRequests.push(route.request().postDataJSON())
    return route.fulfill({
      json: { ok: true, projects: [{ code: 'BKK-03', status: 'ok', costCodes: [{ code: 'TRF', committed: 1250000, awarded: true, known: true }] }] },
    })
  })

  await openApp(page)
  await page.getByRole('button', { name: 'Plan with AI' }).click()
  const dialog = page.getByRole('dialog', { name: 'Plan with AI' })
  await dialog.getByLabel('Project', { exact: true }).selectOption('BKK-03')
  await dialog.getByLabel('Equipment type').selectOption('Power transformer')
  await dialog.getByLabel('Equipment name').fill('400 MVA transformer')
  await dialog.getByLabel('Required on site').fill(REQUIRED)
  await dialog.getByRole('button', { name: 'Generate' }).click()
  await dialog.getByRole('button', { name: 'Create schedule' }).click()
  await expect(page.getByRole('heading', { name: 'LLE – 400 MVA transformer' })).toBeVisible()
  await expect(await gridCell(page, 1, 'Cost code')).toHaveText('TRF — Transformer')

  await page.getByRole('button', { name: 'Sync with Procore' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Last synced' })).toHaveText(/^Last synced \d\d:\d\d · 1 item updated$/)
  expect(syncRequests).toEqual([{ projects: [{ code: 'BKK-03', costCodes: ['TRF'] }] }])
  await expect(await gridCell(page, 1, 'Committed (Procore)')).toHaveText('1250000')
  await expect(await gridCell(page, 1, 'Awarded')).toHaveText('Yes')
  await expect(await gridCell(page, 14, 'Awarded')).toHaveText('Yes')
})

test('Data centre All: full plan from the master template, package rows coded', async ({ page }) => {
  await page.clock.setFixedTime(new Date(`${TODAY}T10:00:00`))
  await page.route('**/api/planner/options', (route) =>
    route.fulfill({
      json: {
        ...OPTIONS,
        scheduleTypes: [
          { id: 'dc-master', name: 'Data centre master schedule', description: 'Full DC plan', projectTypes: ['data-centre'], itemLabels: { noun: 'plan', typeExample: '', nameExample: '', heading: 'Which data centre are you planning?', intro: 'Choose the project and its Ready for Service date. The full plan is built backward from that date.', dateLabel: 'RFS date' } },
          ...OPTIONS.scheduleTypes,
        ],
        projects: [{ code: 'BKK-03', name: 'Bangkok 3', isProgram: false, projectType: 'data-centre', inProcore: true }],
        costCodes: [
          { code: 'CHL', description: 'Chiller', equipmentType: 'Chiller' },
          { code: 'GEN', description: 'Generator', equipmentType: 'Diesel generator' },
          { code: 'TRF', description: 'Transformer', equipmentType: 'Power transformer' },
          { code: 'HVS', description: 'HV SwitchGear', equipmentType: 'HV switchgear' },
        ],
      } satisfies PlannerOptions,
    }),
  )
  const requests: PlanRequest[] = []
  await page.route('**/api/planner/draft', (route) => {
    const request = route.request().postDataJSON() as PlanRequest
    requests.push(request)
    return route.fulfill({ json: { ok: true, draft: buildDcMasterDraft({ request, catalog: dcMasterCatalog(), histories: {} }) } })
  })

  await openApp(page)
  await page.getByRole('button', { name: 'Plan with AI' }).click()
  const dialog = page.getByRole('dialog', { name: 'Plan with AI' })
  await expect(dialog.getByLabel('Schedule type')).toHaveValue('dc-master')
  await expect(dialog.getByLabel('Schedule type').locator('option').first()).toHaveText('All (full project plan)')
  await dialog.getByLabel('Project', { exact: true }).selectOption('BKK-03')
  await dialog.getByLabel('RFS date').fill('2030-06-28')
  await dialog.getByRole('button', { name: 'Generate' }).click()
  await expect(dialog.getByRole('table')).toBeVisible()
  expect(requests).toEqual([{ scheduleType: 'dc-master', equipmentType: 'Data centre', equipmentName: 'Bangkok 3', requiredDate: '2030-06-28' }])
  await expect(dialog.getByText(/Dates use a 7-day working week/)).toBeVisible()

  await dialog.getByRole('button', { name: 'Create schedule' }).click()
  await expect(page.getByRole('heading', { name: 'Full plan – Bangkok 3' })).toBeVisible()
  await expect(await gridCell(page, 1, 'Activity ID')).toHaveText('DC-0001')
  await expect(await gridCell(page, 1, 'Basis')).toHaveText('template')
  await expect(await gridCell(page, 1, 'Project')).toHaveText('BKK-03 — Bangkok 3')

  // Chillers step 1 (DC-0082) is row 82: scroll the grid to it.
  const chiller = await gridCell(page, 82, 'Cost code')
  for (let i = 0; i < 60 && (await chiller.count()) === 0; i++) {
    await page.getByRole('grid').hover()
    await page.mouse.wheel(0, 400)
  }
  await expect(await gridCell(page, 82, 'Activity ID')).toHaveText('DC-0082')
  await expect(chiller).toHaveText('CHL — Chiller')
  await expect(await gridCell(page, 82, 'Delivery site')).toHaveText('BKK-03 — Bangkok 3')
})
