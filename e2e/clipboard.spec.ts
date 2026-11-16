import { expect, test, type Page } from '@playwright/test'
import { createScheduleSheet, expectSaved, gridCell, signUp, USER_A } from './support/app'

/**
 * Pastes text at the focused grid cell with a synthetic paste event carrying a DataTransfer,
 * exactly what the browser dispatches for Ctrl/Cmd+V, without depending on the OS clipboard.
 */
async function pasteText(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', t)
    const target = document.activeElement ?? document.body
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
  }, text)
}

/** Fires a synthetic copy (or cut) at the focused cell and returns the text the grid wrote. */
async function copyText(page: Page, type: 'copy' | 'cut' = 'copy'): Promise<string> {
  return page.evaluate((kind) => {
    const clipboardData = new DataTransfer()
    const target = document.activeElement ?? document.body
    target.dispatchEvent(new ClipboardEvent(kind, { clipboardData, bubbles: true, cancelable: true }))
    return clipboardData.getData('text/plain')
  }, type)
}

const selected = (page: Page) => page.getByRole('grid').locator('[role="gridcell"][aria-selected="true"]')

test('range selection, copy, paste and clear in the grid', async ({ page }) => {
  await signUp(page, USER_A)
  await createScheduleSheet(page)
  const addRow = page.getByRole('button', { name: 'Add row' })
  for (let i = 0; i < 3; i++) await addRow.click()
  await expect(page.getByRole('grid').getByRole('row')).toHaveCount(4) // header + 3 rows

  // A block pasted from a spreadsheet app (CRLF, trailing line break, a quoted cell).
  await (await gridCell(page, 1, 'Task')).click()
  await pasteText(page, 'Pour footings\tFoundations\r\nFrame walls\t"Structure\tlevel 1"\r\nRough electrical\tServices\r\n')
  await expect(await gridCell(page, 1, 'Task')).toHaveText('Pour footings')
  await expect(await gridCell(page, 2, 'Phase')).toHaveText('Structure\tlevel 1')
  await expect(await gridCell(page, 3, 'Task')).toHaveText('Rough electrical')
  await expect(selected(page)).toHaveCount(6) // the pasted block is selected

  // Shift+click and Shift+Arrow extend a range; copying it gives TSV.
  await (await gridCell(page, 1, 'Task')).click()
  await expect(selected(page)).toHaveCount(1)
  await page.keyboard.down('Shift')
  await (await gridCell(page, 2, 'Phase')).click()
  await page.keyboard.up('Shift')
  await expect(selected(page)).toHaveCount(4)
  expect(await copyText(page)).toBe('Pour footings\tFoundations\nFrame walls\t"Structure\tlevel 1"')
  await page.keyboard.press('Shift+ArrowDown')
  await expect(selected(page)).toHaveCount(6)

  // One value pasted into a range fills it.
  await (await gridCell(page, 1, 'Duration')).click()
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  await pasteText(page, '2d')
  for (const n of [1, 2, 3]) await expect(await gridCell(page, n, 'Duration')).toHaveText('2d')

  // An invalid value keeps the old one, marks the cell and is summed up in one notice.
  await (await gridCell(page, 1, 'Status')).click()
  await pasteText(page, 'Bogus\tnot a percent')
  const status1 = await gridCell(page, 1, 'Status')
  await expect(status1).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByRole('status').filter({ hasText: '2 cells were not pasted: row 1 Status' })).toBeVisible()

  // Cut clears the cut cells; Backspace clears a selection.
  await (await gridCell(page, 3, 'Task')).click()
  expect(await copyText(page, 'cut')).toBe('Rough electrical')
  await expect(await gridCell(page, 3, 'Task')).toHaveText('')
  await (await gridCell(page, 2, 'Phase')).click()
  await page.keyboard.press('Shift+ArrowUp')
  await page.keyboard.press('Backspace')
  await expect(await gridCell(page, 1, 'Phase')).toHaveText('')
  await expect(await gridCell(page, 2, 'Phase')).toHaveText('')

  // Everything pasted was saved like typed edits.
  await expectSaved(page)
  await page.reload()
  await page.getByRole('button', { name: /^Project schedule/ }).click()
  await expect(await gridCell(page, 2, 'Task')).toHaveText('Frame walls')
  await expect(await gridCell(page, 3, 'Duration')).toHaveText('2d')
  await expect(await gridCell(page, 1, 'Phase')).toHaveText('')
})

test('the keyboard shortcuts use the real clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await signUp(page, USER_A)
  await createScheduleSheet(page)
  const addRow = page.getByRole('button', { name: 'Add row' })
  for (let i = 0; i < 2; i++) await addRow.click()
  await expect(page.getByRole('grid').getByRole('row')).toHaveCount(3)

  await page.evaluate(() => navigator.clipboard.writeText('Excavate\tSitework\r\nBackfill\tSitework\r\n'))
  await (await gridCell(page, 1, 'Task')).click()
  await page.keyboard.press('ControlOrMeta+V')
  await expect(await gridCell(page, 2, 'Task')).toHaveText('Backfill')
  await expect(await gridCell(page, 2, 'Phase')).toHaveText('Sitework')

  await page.keyboard.press('ControlOrMeta+C')
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Excavate\tSitework\nBackfill\tSitework')
})
