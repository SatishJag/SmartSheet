import { expect, test, type Page } from '@playwright/test'
import { createScheduleSheet, editCell, expectSaved, ganttBar, gridCell, openTab, signUp, USER_A } from './support/app'

async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Schedule settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Schedule settings' })
  await expect(dialog).toBeVisible()
  return dialog
}

test('schedule settings: a non-working weekday moves dates, settings persist, dependencies can be turned off', async ({ page }) => {
  await signUp(page, USER_A)
  await createScheduleSheet(page)

  const addRow = page.getByRole('button', { name: 'Add row' })
  await addRow.click()
  await addRow.click()
  await editCell(page, 1, 'Task', 'Task 1')
  await editCell(page, 1, 'Start', '2026-11-09') // a Monday
  await editCell(page, 1, 'Duration', '3d')
  await editCell(page, 2, 'Task', 'Task 2')
  await editCell(page, 2, 'Duration', '2d')
  await editCell(page, 2, 'Predecessors', '1')
  await expect(await gridCell(page, 1, 'End')).toHaveText('2026-11-11')
  await expect(await gridCell(page, 2, 'End')).toHaveText('2026-11-13')

  // Validation errors show inline and keep the dialog open.
  let dialog = await openSettings(page)
  const hours = dialog.getByRole('spinbutton', { name: 'Hours per day' })
  await hours.fill('30')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog.getByRole('alert')).toContainText('Hours per day must be between 1 and 24')
  await hours.fill('8')

  // Wednesdays are no longer working days.
  await dialog.getByRole('checkbox', { name: 'Wednesday' }).uncheck()
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()

  // Task 1 runs Mon, Tue, Thu; task 2 follows on Fri and Mon.
  await expect(await gridCell(page, 1, 'End')).toHaveText('2026-11-12')
  await expect(await gridCell(page, 2, 'Start')).toHaveText('2026-11-13')
  await expect(await gridCell(page, 2, 'End')).toHaveText('2026-11-16')
  await openTab(page, 'Gantt')
  await expect(ganttBar(page, 'Task 2')).toHaveAttribute('aria-label', 'Task 2: 2026-11-13 to 2026-11-16, 2 days, 0% complete')

  // The settings come back from the backend.
  await expectSaved(page)
  await page.reload()
  await page.getByRole('button', { name: /^Project schedule/ }).click()
  await expect(page.getByRole('grid')).toBeVisible()
  await expect(await gridCell(page, 2, 'End')).toHaveText('2026-11-16')
  dialog = await openSettings(page)
  await expect(dialog.getByRole('checkbox', { name: 'Wednesday' })).not.toBeChecked()
  await expect(dialog.getByRole('checkbox', { name: 'Dependencies drive dates' })).toBeChecked()

  // Escape closes without saving.
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  // Turning dependencies off keeps the predecessor but lets task 2 take a typed start.
  dialog = await openSettings(page)
  await dialog.getByRole('checkbox', { name: 'Dependencies drive dates' }).uncheck()
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()
  await expect(await gridCell(page, 2, 'Predecessors')).toHaveText('1FS')
  await editCell(page, 2, 'Start', '2026-11-09')
  await expect(await gridCell(page, 2, 'End')).toHaveText('2026-11-10')
  await expectSaved(page)
})
