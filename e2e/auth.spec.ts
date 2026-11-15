import { expect, test } from '@playwright/test'
import { becomeNewVisitor, createScheduleSheet, openApp, returnAsVisitor } from './support/app'

// MVP: there is no sign-in. Each browser gets its own anonymous session on its first visit.

test('the app opens straight to the sheet list, with no sign-in, and keeps the visitor across reloads', async ({ page }) => {
  await openApp(page)
  await expect(page.getByText('No sheets yet')).toBeVisible()
  await expect(page.getByLabel('Email')).toHaveCount(0)
  await expect(page.getByLabel('Password')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0)

  await createScheduleSheet(page)
  await page.getByRole('button', { name: 'Back to sheets' }).click()
  await page.reload()
  await expect(page.getByRole('button', { name: /^Project schedule/ })).toHaveCount(1)
})

test("another visitor sees none of the first visitor's sheets", async ({ page }) => {
  await openApp(page)
  await createScheduleSheet(page)
  await page.getByRole('button', { name: 'Back to sheets' }).click()
  const sheetButton = page.getByRole('button', { name: /^Project schedule/ })
  await expect(sheetButton).toHaveCount(1)

  const first = await becomeNewVisitor(page)
  expect(first).toBeTruthy()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Your sheets' })).toBeVisible()
  await expect(page.getByText('No sheets yet')).toBeVisible()
  await expect(sheetButton).toHaveCount(0)

  await returnAsVisitor(page, first!)
  await page.reload()
  await expect(sheetButton).toHaveCount(1)
})

test('rename a sheet, then delete it', async ({ page }) => {
  await openApp(page)
  await createScheduleSheet(page)
  await page.getByRole('button', { name: 'Back to sheets' }).click()

  await page.getByRole('button', { name: 'Rename Project schedule' }).click()
  const name = page.getByRole('textbox', { name: 'Sheet name' })
  await expect(name).toBeFocused()
  await name.fill('Tower A schedule')
  await name.press('Enter')
  const renamed = page.getByRole('button', { name: /^Tower A schedule/ })
  await expect(renamed).toHaveCount(1)
  await page.reload()
  await expect(renamed).toHaveCount(1) // saved in the backend

  await page.getByRole('button', { name: 'Delete Tower A schedule' }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Delete sheet' })
  await expect(dialog).toContainText('Delete "Tower A schedule" and all of its rows?')
  await dialog.getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByText('No sheets yet')).toBeVisible()
  await page.reload()
  await expect(page.getByText('No sheets yet')).toBeVisible()
})
