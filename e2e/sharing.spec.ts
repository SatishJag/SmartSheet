import { expect, test, type Page } from '@playwright/test'
import { createScheduleSheet, editCell, expectSaved, gridCell, signIn, signOut, signUp, USER_A, USER_B } from './support/app'

const sheetButton = (page: Page) => page.getByRole('button', { name: /^Project schedule/ })

async function openSharedDialog(page: Page) {
  await page.getByRole('button', { name: 'Share', exact: true }).click()
  await expect(page.getByRole('dialog', { name: /Share/ })).toBeVisible()
}

test('an owner shares a sheet: a viewer can only read it, an editor can edit it', async ({ page }) => {
  // B must have an account before A can share with them.
  await signUp(page, USER_B)
  await signOut(page)

  await signUp(page, USER_A)
  await createScheduleSheet(page)
  await page.getByRole('button', { name: 'Add row' }).click()
  await editCell(page, 1, 'Task', 'Footing')
  await expectSaved(page)

  await openSharedDialog(page)
  await page.getByRole('dialog').getByLabel('Email').fill(USER_B.email)
  await page.getByRole('dialog').getByRole('button', { name: 'Share', exact: true }).click()
  await expect(page.getByLabel(`Role for ${USER_B.email}`)).toHaveValue('viewer')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: 'Back to sheets' }).click()
  await signOut(page)

  // The viewer sees the sheet marked as shared, with its data, but cannot change it.
  await signIn(page, USER_B)
  await expect(sheetButton(page)).toContainText('Shared with you')
  await expect(page.getByRole('button', { name: /^Rename / })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Delete / })).toHaveCount(0)
  await sheetButton(page).click()
  await expect(page.getByText('View only')).toBeVisible()
  await expect(await gridCell(page, 1, 'Task')).toHaveText('Footing')
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Rename sheet' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Add row' })).toBeDisabled()
  await (await gridCell(page, 1, 'Task')).dblclick()
  await expect(page.getByRole('grid').getByRole('textbox')).toHaveCount(0)
  await page.getByRole('button', { name: 'Back to sheets' }).click()
  await signOut(page)

  // The owner promotes B to editor.
  await signIn(page, USER_A)
  await sheetButton(page).click()
  await openSharedDialog(page)
  await page.getByLabel(`Role for ${USER_B.email}`).selectOption('editor')
  await expect(page.getByLabel(`Role for ${USER_B.email}`)).toHaveValue('editor')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Back to sheets' }).click()
  await signOut(page)

  // The editor edits the owner's sheet, and the owner sees the change.
  await signIn(page, USER_B)
  await sheetButton(page).click()
  await expect(page.getByText(/can edit/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toHaveCount(0)
  await editCell(page, 1, 'Task', 'Footing and slab')
  await expectSaved(page)
  await page.getByRole('button', { name: 'Back to sheets' }).click()
  await signOut(page)
  await signIn(page, USER_A)
  await sheetButton(page).click()
  await expect(await gridCell(page, 1, 'Task')).toHaveText('Footing and slab')

  // Removing B ends their access.
  await openSharedDialog(page)
  await page.getByRole('button', { name: `Remove ${USER_B.email}` }).click()
  await expect(page.getByText('Not shared with anyone yet')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Back to sheets' }).click()
  await signOut(page)
  await signIn(page, USER_B)
  await expect(page.getByText('No sheets yet')).toBeVisible()
})
