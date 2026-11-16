import { expect, test } from '@playwright/test'
import { createScheduleSheet, editCell, ganttBar, openTab, signUp, USER_A } from './support/app'

test('the critical path view highlights the longest chain and shows float', async ({ page }) => {
  await signUp(page, USER_A)
  await createScheduleSheet(page)

  // Task 1 (3d, Mon 11-09) -> Task 2 (2d) -> Task 4 (1d), and Task 1 -> Task 3 (1d) -> Task 4.
  const addRow = page.getByRole('button', { name: 'Add row' })
  for (let i = 0; i < 4; i++) await addRow.click()
  const plan: [string, string, string?][] = [
    ['Task 1', '3d'],
    ['Task 2', '2d', '1'],
    ['Task 3', '1d', '1'],
    ['Task 4', '1d', '2,3'],
  ]
  for (const [i, [name, duration, preds]] of plan.entries()) {
    await editCell(page, i + 1, 'Task', name)
    await editCell(page, i + 1, 'Duration', duration)
    if (i === 0) await editCell(page, 1, 'Start', '2026-11-09')
    if (preds) await editCell(page, i + 1, 'Predecessors', preds)
  }

  await page.getByRole('checkbox', { name: 'Critical path' }).check()
  await openTab(page, 'Gantt')

  for (const name of ['Task 1', 'Task 2', 'Task 4']) await expect(ganttBar(page, name)).toHaveClass(/is-critical/)
  await expect(ganttBar(page, 'Task 3')).not.toHaveClass(/is-critical/)
  await expect(page.getByText('1d float')).toBeVisible()
  await expect(page.getByText('Critical', { exact: true })).toHaveCount(3)
  await expect(page.locator('[data-testid="dep-arrow"][data-critical="true"]')).toHaveCount(2)

  // Make the short branch the long one: the highlight moves with the schedule.
  await openTab(page, 'Grid')
  await editCell(page, 3, 'Duration', '5d')
  await openTab(page, 'Gantt')
  await expect(ganttBar(page, 'Task 3')).toHaveClass(/is-critical/)
  await expect(ganttBar(page, 'Task 2')).not.toHaveClass(/is-critical/)

  // Switching it off removes the highlight.
  await openTab(page, 'Grid')
  await page.getByRole('checkbox', { name: 'Critical path' }).uncheck()
  await openTab(page, 'Gantt')
  await expect(page.locator('.is-critical')).toHaveCount(0)
})
