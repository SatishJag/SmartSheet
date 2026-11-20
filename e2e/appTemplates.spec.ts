import { expect, test } from '@playwright/test'
import { signUp, USER_A } from './support/app'

test('creates a Data Center app: plan sheet, support sheets and a resource project', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-18T10:00:00'))
  await signUp(page, USER_A)
  await page.getByRole('button', { name: 'Create app from template' }).click()
  await expect(page.getByRole('heading', { name: 'Create app' })).toBeVisible()
  await page.screenshot({ path: 'test-results/apps-gallery.png', fullPage: true })

  await page.getByRole('button', { name: /Data Center Build/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Data Center Build' })
  await expect(dialog.getByText('About this app template')).toBeVisible()
  await dialog.getByLabel('Project name').fill('DC1 Ashburn')
  await dialog.getByLabel('Client (optional)').fill('Hyperscale Co')
  await dialog.getByLabel('Start date').fill('2026-11-23')
  await expect(dialog.getByRole('note')).toContainText('We\'ll create 4 sheets named "DC1 Ashburn – …"')
  await page.screenshot({ path: 'test-results/apps-dialog.png' })
  await dialog.getByRole('button', { name: 'Create' }).click()

  // Lands in the new plan sheet
  await expect(page.getByRole('heading', { name: 'DC1 Ashburn – Project plan' })).toBeVisible()
  await expect(page.getByRole('grid')).toBeVisible()
  await expect(page.getByText('Site selection and feasibility')).toBeVisible()
  await page.getByRole('tab', { name: 'Gantt' }).click()
  await page.screenshot({ path: 'test-results/apps-gantt.png' })
  await page.getByRole('button', { name: /Back/ }).click()

  for (const name of ['Project plan', 'Long-lead equipment', 'Commissioning tracker', 'Risk register']) {
    await expect(page.getByRole('button', { name: `DC1 Ashburn – ${name}`, exact: false }).first()).toBeVisible()
  }

  // Resource management: project linked to the plan, placeholder roles scheduled
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'People & projects' }).click()
  await expect(page.getByRole('button', { name: 'Commissioning Agent' })).toBeVisible()
  await page.getByRole('tab', { name: 'Projects' }).click()
  const row = page.getByRole('row', { name: /DC1 Ashburn/ })
  await expect(row).toContainText('Hyperscale Co')
  await expect(row).toContainText('11/23/2026')
  await expect(row).toContainText('days remaining')
  await expect(row.getByRole('button', { name: 'DC1 Ashburn – Project plan' })).toBeVisible()
  await page.getByRole('tab', { name: 'Schedule' }).click()
  await expect(page.getByRole('rowgroup', { name: 'Electrical Engineer' }).getByRole('button', { name: /DC1 Ashburn · \d+%/ }).first()).toBeVisible()
  await page.screenshot({ path: 'test-results/apps-schedule.png' })
})
