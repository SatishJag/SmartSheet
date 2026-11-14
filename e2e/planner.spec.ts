import { expect, test } from '@playwright/test'
import { defaultCalendar } from '../src/engine/calendar'
import { planBackward } from '../src/planner/backward'
import type { PlannerOptions, PlanRequest } from '../src/planner/types'
import { catalogDraft } from '../src/test/plannerFixtures'
import { ganttBar, gridCell, openTab, signUp, USER_A } from './support/app'

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

  await signUp(page, USER_A)
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
