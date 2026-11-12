import { expect, test, type Page } from '@playwright/test'
import { createScheduleSheet, editCell, expectSaved, gridCell, signUp, USER_A } from './support/app'

const headerTitles = (page: Page) => page.getByRole('columnheader')

async function columnMenu(page: Page, title: string, action: string): Promise<void> {
  await page.getByRole('button', { name: `Column menu for ${title}` }).click()
  await page.getByRole('menu', { name: `${title} column` }).getByRole('menuitem', { name: action }).click()
}

test('add, rename (formulas follow) and delete columns, and the changes persist', async ({ page }) => {
  await signUp(page, USER_A)
  await createScheduleSheet(page)
  await page.getByRole('button', { name: 'Add row' }).click()
  await editCell(page, 1, 'Task', 'Pour footings')

  // Add a column at the end of the header.
  await page.getByRole('button', { name: 'Add column' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add column' })
  await dialog.getByLabel('Column name').fill('Cost')
  await dialog.getByRole('button', { name: 'Add column' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(headerTitles(page).last()).toHaveText('Cost')
  await editCell(page, 1, 'Cost', '1200')

  // Insert a formula column right of Cost that refers to it.
  await columnMenu(page, 'Cost', 'Insert column right')
  await page.getByRole('dialog', { name: 'Add column' }).getByLabel('Column name').fill('Total')
  await page.getByRole('dialog', { name: 'Add column' }).getByLabel('Column name').press('Enter')
  const total = await editCell(page, 1, 'Total', '=[Cost] * 2')
  await expect(total).toHaveText('2400')

  // Rename Cost: the formula is rewritten and keeps working.
  await columnMenu(page, 'Cost', 'Rename column')
  const rename = page.getByRole('textbox', { name: 'Rename column Cost' })
  await rename.fill('Price')
  await rename.press('Enter')
  await expect(page.getByRole('columnheader', { name: 'Price' })).toBeVisible()
  await expect(await gridCell(page, 1, 'Total')).toHaveText('2400')

  // Insert a column left of Total, then delete it, confirming first.
  await columnMenu(page, 'Total', 'Insert column left')
  await page.getByRole('dialog', { name: 'Add column' }).getByLabel('Column name').fill('Scratch')
  await page.getByRole('dialog', { name: 'Add column' }).getByRole('button', { name: 'Add column' }).click()
  await editCell(page, 1, 'Scratch', 'temporary')
  await columnMenu(page, 'Scratch', 'Delete column')
  await page.getByRole('alertdialog', { name: 'Delete column' }).getByRole('button', { name: 'Delete column' }).click()
  await expect(page.getByRole('columnheader', { name: 'Scratch' })).toHaveCount(0)

  // After a reload: the new name, the values and the rewritten formula were all saved.
  await expectSaved(page)
  await page.reload()
  await page.getByRole('button', { name: /^Project schedule/ }).click()
  await expect(await gridCell(page, 1, 'Price')).toHaveText('1200')
  await expect(await gridCell(page, 1, 'Total')).toHaveText('2400')
  await expect(page.getByRole('columnheader', { name: 'Scratch' })).toHaveCount(0)
  await expect(headerTitles(page).last()).toHaveText('Total')
  const formula = await gridCell(page, 1, 'Total')
  await formula.dblclick()
  await expect(formula.getByLabel('Total', { exact: true })).toHaveValue('=[Price] * 2')
  await page.keyboard.press('Escape')
})
