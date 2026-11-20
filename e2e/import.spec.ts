import { expect, test } from '@playwright/test'
import { openApp } from './support/app'

const csv = 'Task,Due,Done,Qty\r\nPour footings,2026-03-02,true,4\r\n"Frame, walls",2026-03-09,false,6\r\n'

test('import a CSV file into a new sheet and keep editing it like any other sheet', async ({ page }) => {
  await openApp(page)
  await page.getByLabel('Import CSV').setInputFiles({ name: 'Site tasks.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })

  const headers = page.getByRole('columnheader')
  for (const title of ['Task', 'Due', 'Done', 'Qty']) await expect(headers.filter({ hasText: title })).toHaveCount(1)
  await expect(page.getByText('Frame, walls')).toBeVisible()
  await expect(page.getByText('Site tasks').first()).toBeVisible()

  // An imported column behaves like any other: a column formula can read it.
  await page.getByRole('button', { name: 'Column menu for Qty' }).click()
  await page.getByRole('menu', { name: 'Qty column' }).getByRole('menuitem', { name: 'Insert column right' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add column' })
  await dialog.getByLabel('Column name').fill('Double')
  await dialog.getByLabel('Column name').press('Enter')
  await expect(headers.filter({ hasText: 'Double' })).toHaveCount(1)
})

test('a file that cannot be imported shows why and creates nothing', async ({ page }) => {
  await openApp(page)
  await page.getByLabel('Import CSV').setInputFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from('A\n"oops\n') })
  await expect(page.getByRole('alert')).toContainText('Could not import "bad.csv"')
  await expect(page.getByRole('columnheader')).toHaveCount(0)
})
