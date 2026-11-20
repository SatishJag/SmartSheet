import { expect, test, type Page } from '@playwright/test'
import { createScheduleSheet, editCell, expectSaved, gridCell, openApp } from './support/app'

async function addColumn(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Add column' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add column' })
  await dialog.getByLabel('Column name').fill(name)
  await dialog.getByRole('button', { name: 'Add column' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('columnheader').last()).toHaveText(name)
}

async function columnMenu(page: Page, title: string, action: string | RegExp): Promise<void> {
  const menu = page.getByRole('menu', { name: `${title} column` })
  // The menu closes when the grid scrolls, and clicking the button can scroll it into view (right after a
  // reload, say): click again until the menu stays open.
  await expect(async () => {
    await page.getByRole('button', { name: `Column menu for ${title}` }).click()
    await expect(menu).toBeVisible({ timeout: 1000 })
  }).toPass()
  await menu.getByRole('menuitem', { name: action }).click()
}

const formulaBar = (page: Page) => page.getByRole('textbox', { name: 'Formula bar' })

test('cell formulas, column formulas, live updates, errors and the formula bar', async ({ page }) => {
  await openApp(page)
  await createScheduleSheet(page)
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Add row' }).click()
  await editCell(page, 1, 'Task', 'Footings')
  await editCell(page, 2, 'Task', 'Slab')
  await editCell(page, 3, 'Task', 'Walls')

  await addColumn(page, 'Qty')
  await addColumn(page, 'Rate')
  await addColumn(page, 'Total')
  for (const [row, qty, rate] of [[1, '2', '10'], [2, '3', '5'], [3, '4', '2']] as const) {
    await editCell(page, row, 'Qty', qty)
    await editCell(page, row, 'Rate', rate)
  }

  // A formula typed into one cell.
  const first = await editCell(page, 1, 'Total', '=[Qty]@row * [Rate]@row')
  await expect(first).toHaveText('20')

  // A column formula: every row whose own cell is empty gets it; row 1 keeps its own formula.
  await columnMenu(page, 'Total', 'Set column formula')
  const dialog = page.getByRole('dialog', { name: 'Column formula: Total' })
  const text = dialog.getByRole('combobox', { name: 'Formula' })
  await text.fill('=[Qty]@row * [Rate]@row + 1')
  // The live preview evaluates the first row (the row's own cell is ignored there).
  await expect(dialog.getByTestId('formula-preview')).toContainText('21')
  await dialog.getByRole('button', { name: 'Set formula' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(await gridCell(page, 1, 'Total')).toHaveText('20') // its own formula wins
  await expect(await gridCell(page, 2, 'Total')).toHaveText('16')
  await expect(await gridCell(page, 3, 'Total')).toHaveText('9')

  // Results follow a dependency that changes.
  await editCell(page, 2, 'Qty', '10')
  await expect(await gridCell(page, 2, 'Total')).toHaveText('51')
  await editCell(page, 1, 'Qty', '7')
  await expect(await gridCell(page, 1, 'Total')).toHaveText('70')

  // A row added later gets the column formula without anything being typed.
  await page.getByRole('button', { name: 'Add row' }).click()
  await expect(await gridCell(page, 4, 'Total')).toHaveText('1') // blank * blank + 1
  await editCell(page, 4, 'Qty', '5')
  await editCell(page, 4, 'Rate', '3')
  await expect(await gridCell(page, 4, 'Total')).toHaveText('16')

  // Typing in a cell overrides the column formula; clearing it brings the formula back.
  await editCell(page, 3, 'Total', '999')
  await expect(await gridCell(page, 3, 'Total')).toHaveText('999')
  const cleared = await gridCell(page, 3, 'Total')
  await cleared.click()
  await page.keyboard.press('Backspace')
  await expect(cleared).toHaveText('9')

  // An error cell shows the error name; its tooltip explains it.
  const bad = await editCell(page, 3, 'Total', '=[Qty]@row / 0')
  await expect(bad.locator('.cell-text')).toHaveText('#DIVIDE BY ZERO')
  await expect(bad).toHaveAttribute('title', /^#DIVIDE BY ZERO: .*zero/i)
  await expect(bad).toHaveAttribute('aria-invalid', 'true')
  await editCell(page, 3, 'Total', '=FOO(1)')
  await expect((await gridCell(page, 3, 'Total')).locator('.cell-text')).toHaveText('#UNPARSEABLE')
  await expect(await gridCell(page, 3, 'Total')).toHaveAttribute('title', /Unknown function 'FOO'/)

  // The formula bar shows =... for a formula cell and edits it; Enter commits, Escape cancels.
  const one = await gridCell(page, 1, 'Total')
  await one.click()
  await expect(formulaBar(page)).toHaveValue('=[Qty]@row * [Rate]@row')
  await formulaBar(page).fill('=[Qty]@row * 100')
  await formulaBar(page).press('Escape')
  await expect(formulaBar(page)).toHaveValue('=[Qty]@row * [Rate]@row')
  await expect(one).toHaveText('70')
  await formulaBar(page).fill('=[Qty]@row * 100')
  await formulaBar(page).press('Enter')
  await expect(one).toHaveText('700')
  await expect(one).toBeFocused()

  // A cell that only shows the column formula: the bar shows the column's formula.
  const four = await gridCell(page, 4, 'Total')
  await four.click()
  await expect(formulaBar(page)).toHaveValue('=[Qty]@row * [Rate]@row + 1')
  await expect(page.getByText('Column formula', { exact: true })).toBeVisible()

  // Everything survives a reload (the column formula is saved on the column).
  await expectSaved(page)
  await page.reload()
  await page.getByRole('button', { name: /^Project schedule/ }).click()
  await expect(await gridCell(page, 4, 'Total')).toHaveText('16')
  await expect(await gridCell(page, 1, 'Total')).toHaveText('700')

  // Clearing the column formula empties the cells that used it.
  await columnMenu(page, 'Total', 'Clear column formula')
  await expect(await gridCell(page, 4, 'Total')).toHaveText('')
  await expect(await gridCell(page, 1, 'Total')).toHaveText('700') // its own formula stays
})

test('function autocomplete in the column formula dialog', async ({ page }) => {
  await openApp(page)
  await createScheduleSheet(page)
  await page.getByRole('button', { name: 'Add row' }).click()
  await addColumn(page, 'Cost')
  await columnMenu(page, 'Cost', 'Set column formula')
  const dialog = page.getByRole('dialog', { name: 'Column formula: Cost' })
  const text = dialog.getByRole('combobox', { name: 'Formula' })
  await text.pressSequentially('=ROUN')
  await expect(dialog.getByRole('option')).toHaveCount(3)
  await expect(dialog.getByRole('option').first()).toContainText('ROUND(number, [digits])')
  await text.press('Tab')
  await expect(text).toHaveValue('=ROUND(')
  await text.pressSequentially('2.567, 2)')
  await expect(dialog.getByTestId('formula-preview')).toContainText('2.57')
  await text.press('Enter')
  await expect(dialog).toHaveCount(0)
  await expect(await gridCell(page, 1, 'Cost')).toHaveText('2.57')
})
