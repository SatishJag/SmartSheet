import { expect, test, type Page } from '@playwright/test'
import { createScheduleSheet, editCell, expectSaved, gridCell, openTab, signUp, USER_A } from './support/app'

const lane = (page: Page, name: string) => page.getByRole('region', { name: new RegExp(`^${name} \\(\\d+\\)$`) })
const card = (page: Page, name: string) => page.getByRole('listitem').filter({ hasText: name })

test('dragging a card to another lane, and the Move-to select, write the Status cell', async ({ page }) => {
  await signUp(page, USER_A)
  await createScheduleSheet(page)
  const tasks = [
    ['Pour footings', 'Not started'],
    ['Frame walls', 'In progress'],
    ['Rough electrical', 'Not started'],
  ] as const
  const addRow = page.getByRole('button', { name: 'Add row' })
  for (const [i, [name, status]] of tasks.entries()) {
    await addRow.click()
    await editCell(page, i + 1, 'Task', name)
    await editCell(page, i + 1, 'Status', status)
  }
  await expect(await gridCell(page, 2, 'Status')).toHaveText('In progress')

  await openTab(page, 'Kanban')
  await expect(lane(page, 'Not started')).toHaveAccessibleName('Not started (2)')
  await expect(lane(page, 'In progress')).toHaveAccessibleName('In progress (1)')
  await expect(lane(page, 'Complete')).toHaveAccessibleName('Complete (0)')
  await expect(lane(page, 'In progress').getByRole('listitem').filter({ hasText: 'Frame walls' })).toBeVisible()

  // A real mouse drag (HTML5 drag and drop) into the Complete lane.
  await card(page, 'Frame walls').dragTo(lane(page, 'Complete'))
  await expect(lane(page, 'Complete')).toHaveAccessibleName('Complete (1)')
  await expect(lane(page, 'Complete').getByRole('listitem').filter({ hasText: 'Frame walls' })).toBeVisible()
  await expect(lane(page, 'In progress')).toHaveAccessibleName('In progress (0)')

  await openTab(page, 'Grid')
  await expect(await gridCell(page, 2, 'Status')).toHaveText('Complete')

  // The keyboard / screen-reader path: the card's "Move to" select.
  await openTab(page, 'Kanban')
  await page.getByLabel('Move Frame walls to').selectOption({ label: 'In progress' })
  await expect(lane(page, 'In progress').getByRole('listitem').filter({ hasText: 'Frame walls' })).toBeVisible()
  await expect(lane(page, 'Complete')).toHaveAccessibleName('Complete (0)')

  await openTab(page, 'Grid')
  await expect(await gridCell(page, 2, 'Status')).toHaveText('In progress')

  // And the move was saved.
  await expectSaved(page)
  await page.reload()
  await page.getByRole('button', { name: /^Project schedule/ }).click()
  await expect(await gridCell(page, 2, 'Status')).toHaveText('In progress')
  await expect(await gridCell(page, 1, 'Status')).toHaveText('Not started')
})
