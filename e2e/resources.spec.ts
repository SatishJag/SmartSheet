import { expect, test, type Page } from '@playwright/test'
import { createScheduleSheet, signUp, USER_A } from './support/app'

async function openResources(page: Page) {
  await page.getByRole('navigation', { name: 'Areas' }).getByRole('button', { name: 'Resource Management' }).click()
  await expect(page.getByRole('tab', { name: 'People' })).toHaveAttribute('aria-selected', 'true')
}

async function addPerson(page: Page, p: { first: string; last: string; email?: string; role?: string; discipline?: string; rate?: string }) {
  await page.getByRole('button', { name: 'Add person' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add person' })
  await dialog.getByLabel('First name').fill(p.first)
  await dialog.getByLabel('Last name').fill(p.last)
  if (p.email) await dialog.getByLabel('Email').fill(p.email)
  if (p.role) await dialog.getByLabel('Role').fill(p.role)
  if (p.discipline) await dialog.getByLabel('Discipline').fill(p.discipline)
  if (p.rate) await dialog.getByLabel('Bill rate (per hour)').fill(p.rate)
  await dialog.getByRole('button', { name: 'Add person' }).click()
  await expect(dialog).toBeHidden()
}

test('people, projects, schedule, reports and my work', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-18T10:00:00'))
  await signUp(page, USER_A)
  await openResources(page)

  // People: add, filter, sort
  await addPerson(page, { first: 'Hilda', last: 'Wilson', role: 'Project Manager', discipline: 'Civil', rate: '100' })
  await addPerson(page, { first: 'Jamal', last: 'King', role: 'Electrician', discipline: 'Electrical', email: USER_A.email, rate: '50' })
  await expect(page.getByText('2 matching people')).toBeVisible()
  await page.getByLabel('Discipline:').selectOption('Electrical')
  await expect(page.getByText('1 matching person')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Hilda Wilson' })).toBeHidden()

  // Saved view keeps the filter
  await page.getByRole('button', { name: '+ Save Current View' }).click()
  await page.getByLabel('View name').fill('Sparkies')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('button', { name: 'Everyone' }).click()
  await expect(page.getByText('2 matching people')).toBeVisible()
  await page.getByRole('button', { name: 'Sparkies', exact: true }).click()
  await expect(page.getByText('1 matching person')).toBeVisible()
  await page.getByRole('button', { name: 'Everyone' }).click()

  // Projects
  await page.getByRole('tab', { name: 'Projects' }).click()
  await page.getByRole('button', { name: 'New Project' }).click()
  const pd = page.getByRole('dialog', { name: 'New project' })
  await pd.getByLabel('Project name').fill('Tower A')
  await pd.getByLabel('Client').fill('Ritmo')
  await pd.getByLabel('Project owner').selectOption({ label: 'Hilda Wilson' })
  await pd.getByLabel('Starts').fill('2026-11-16')
  await pd.getByLabel('Ends').fill('2026-12-18')
  await pd.getByLabel('Budget tracking').selectOption('amount')
  await pd.getByLabel('Budget amount').fill('5000')
  await pd.getByRole('button', { name: 'Create project' }).click()
  await expect(pd).toBeHidden()
  await expect(page.getByText('1 matching project')).toBeVisible()
  await expect(page.getByRole('row', { name: /Tower A/ })).toContainText('Ritmo')
  await expect(page.getByRole('row', { name: /Tower A/ })).toContainText('Hilda Wilson')

  // Schedule: assign Hilda at 50% for two weeks
  await page.getByRole('tab', { name: 'Schedule' }).click()
  await page.getByRole('button', { name: 'Assign', exact: true }).click()
  const ad = page.getByRole('dialog', { name: 'New assignment' })
  await ad.getByLabel('Person').selectOption({ label: 'Hilda Wilson' })
  await ad.getByLabel('Starts').fill('2026-11-16')
  await ad.getByLabel('Ends').fill('2026-11-27')
  await ad.getByLabel('Allocation (%)').fill('50')
  await ad.getByRole('button', { name: 'Assign', exact: true }).click()
  await expect(ad).toBeHidden()
  const hilda = page.getByRole('rowgroup', { name: 'Hilda Wilson' })
  await expect(hilda.getByRole('button', { name: 'Tower A · 50%' })).toBeVisible()
  await expect(hilda.getByText('Available: 50%')).toBeVisible()

  // Heatmap
  await page.getByRole('button', { name: 'Allocation Heatmap' }).click()
  await expect(hilda.getByRole('gridcell', { name: '50%' }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Assignment Details' }).click()
  await page.screenshot({ path: 'test-results/rm-schedule.png', fullPage: true })

  // Reports: 10 days at 50% x 8h x $100 = $4,000 forecast of $5,000
  await page.getByRole('tab', { name: 'Reports' }).click()
  const currency = page.getByRole('region', { name: 'Active Projects Tracked in Currency' })
  await expect(currency).toContainText('Tower A')
  await expect(currency).toContainText('$1,000 remaining')
  await page.getByRole('button', { name: /utilization of each person/ }).click()
  await expect(page.getByRole('region', { name: /utilization of each person/ })).toContainText('Hilda Wilson')
  await page.screenshot({ path: 'test-results/rm-reports.png', fullPage: true })

  // My Work: the signed-in user is Jamal (by email)
  await page.getByRole('tab', { name: 'My Work' }).click()
  await expect(page.getByText(/Jamal King · Available for the rest of this week/)).toBeVisible()

  // Data survives a reload
  await page.reload()
  await openResources(page)
  await expect(page.getByText('2 matching people')).toBeVisible()
  await page.getByRole('tab', { name: 'Schedule' }).click()
  await expect(page.getByRole('rowgroup', { name: 'Hilda Wilson' }).getByRole('button', { name: 'Tower A · 50%' })).toBeVisible()
})

test('adds work from a sheet as a linked project', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-18T10:00:00'))
  await signUp(page, USER_A)
  await createScheduleSheet(page)
  await page.getByRole('button', { name: /Back/ }).click()
  await openResources(page)
  await page.getByRole('button', { name: '+ Add work from a sheet' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add work from a sheet' })
  await dialog.getByRole('button', { name: 'Add work' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('status')).toContainText('as a project with 0 assignments')
  await expect(page.getByRole('tab', { name: 'Projects' })).toHaveAttribute('aria-selected', 'true')
  const row = page.getByRole('row', { name: /Project schedule/ })
  await expect(row).toBeVisible()
  // The sheet link opens the sheet
  await row.getByRole('button', { name: 'Project schedule' }).last().click()
  await expect(page.getByRole('grid')).toBeVisible()
})
