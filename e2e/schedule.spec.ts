import { expect, test, type Page } from '@playwright/test'
import { createScheduleSheet, editCell, expectSaved, ganttBar, gridCell, openTab, signUp, USER_A } from './support/app'

const bar1 = (page: Page) => ganttBar(page, 'Task 1')
const bar2 = (page: Page) => ganttBar(page, 'Task 2')

async function expectBars(page: Page, task1: string, task2: string) {
  await openTab(page, 'Gantt')
  await expect(bar1(page)).toHaveAttribute('aria-label', task1)
  await expect(bar2(page)).toHaveAttribute('aria-label', task2)
}

const T1_3D = 'Task 1: 2026-11-09 to 2026-11-11, 3 days, 0% complete'
const T2_AFTER_3D = 'Task 2: 2026-11-12 to 2026-11-13, 2 days, 0% complete'
const T1_4D = 'Task 1: 2026-11-09 to 2026-11-12, 4 days, 0% complete'
// Task 1 now ends Thursday the 12th, so task 2 runs Friday the 13th and Monday the 16th.
const T2_AFTER_4D = 'Task 2: 2026-11-13 to 2026-11-16, 2 days, 0% complete'

test('predecessors drive the Gantt chart, invalid input is flagged, and everything persists', async ({ page }) => {
  await signUp(page, USER_A)
  await createScheduleSheet(page)
  await expect(page.getByText('No rows yet')).toBeVisible()

  const addRow = page.getByRole('button', { name: 'Add row' })
  await addRow.click()
  await addRow.click()
  await expect(page.getByRole('grid').getByRole('row')).toHaveCount(3) // header + 2 rows

  await editCell(page, 1, 'Task', 'Task 1')
  await editCell(page, 1, 'Start', '2026-11-09') // a Monday
  await editCell(page, 1, 'Duration', '3d')
  await editCell(page, 2, 'Task', 'Task 2')
  await editCell(page, 2, 'Duration', '2d')
  // A formula in a text column shows its result; the editor keeps the formula.
  const phase2 = await editCell(page, 2, 'Phase', '=2*21')
  await expect(phase2).toHaveText('42')
  await phase2.dblclick()
  await expect(phase2.getByLabel('Phase', { exact: true })).toHaveValue('=2*21')
  await page.keyboard.press('Escape')
  const pred2 = await editCell(page, 2, 'Predecessors', '1')
  await expect(pred2).toHaveText('1FS') // the app writes predecessors in canonical form
  await expect(await gridCell(page, 2, 'Start')).toHaveText('2026-11-12')
  await expect(await gridCell(page, 2, 'End')).toHaveText('2026-11-13')

  // Task 2 starts the working day after task 1 ends.
  await expectBars(page, T1_3D, T2_AFTER_3D)

  // A longer task 1 pushes task 2 out.
  await openTab(page, 'Grid')
  await editCell(page, 1, 'Duration', '4d')
  await expectBars(page, T1_4D, T2_AFTER_4D)

  // An invalid predecessor is flagged on the cell and changes nothing.
  await openTab(page, 'Grid')
  const bad = await editCell(page, 2, 'Predecessors', '99')
  await expect(bad).toHaveAttribute('aria-invalid', 'true')
  await expect(bad).toHaveAttribute('title', 'Row 99 does not exist')
  await expect(bad).toHaveText(/^1FS/) // still shows the saved predecessor (plus the hidden error text)
  await expectBars(page, T1_4D, T2_AFTER_4D)

  // Reload: the data comes back from the backend.
  await expectSaved(page)
  await page.reload()
  await page.getByRole('button', { name: /^Project schedule/ }).click()
  await expect(page.getByRole('grid')).toBeVisible()
  await expect(await gridCell(page, 1, 'Task')).toHaveText('Task 1')
  await expect(await gridCell(page, 1, 'Start')).toHaveText('2026-11-09')
  await expect(await gridCell(page, 1, 'Duration')).toHaveText('4d')
  await expect(await gridCell(page, 2, 'Task')).toHaveText('Task 2')
  await expect(await gridCell(page, 2, 'Duration')).toHaveText('2d')
  const pred = await gridCell(page, 2, 'Predecessors')
  await expect(pred).toHaveText('1FS')
  await expect(pred).not.toHaveAttribute('aria-invalid', 'true')
  await expectBars(page, T1_4D, T2_AFTER_4D)

  // Deleting the predecessor row removes the dependency, says so, and empties the successor's cell.
  await openTab(page, 'Grid')
  await (await gridCell(page, 1, 'Task')).click()
  await page.getByRole('button', { name: 'Delete row' }).click()
  const notice = page.getByRole('status').filter({ hasText: 'Removed 1 dependency that referenced deleted rows' })
  await expect(notice).toBeVisible()
  await expect(page.getByRole('grid').getByRole('row')).toHaveCount(2) // header + 1 row
  await expect(await gridCell(page, 1, 'Task')).toHaveText('Task 2')
  await expect(await gridCell(page, 1, 'Predecessors')).toHaveText('')
  await page.getByRole('button', { name: 'Dismiss: Removed 1 dependency that referenced deleted rows' }).click()
  await expect(page.getByText('Removed 1 dependency that referenced deleted rows')).toHaveCount(0)

  await expectSaved(page)
  await page.reload()
  await page.getByRole('button', { name: /^Project schedule/ }).click()
  await expect(page.getByRole('grid').getByRole('row')).toHaveCount(2)
  await expect(await gridCell(page, 1, 'Task')).toHaveText('Task 2')
  await expect(await gridCell(page, 1, 'Predecessors')).toHaveText('')
  await expect(await gridCell(page, 1, 'Phase')).toHaveText('42')
})
