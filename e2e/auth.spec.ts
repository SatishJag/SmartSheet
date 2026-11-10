import { expect, test } from '@playwright/test'
import { createScheduleSheet, signIn, signOut, signUp, submitSignIn, USER_A, USER_B } from './support/app'

test('create an account, sign out, sign back in; a wrong password is refused', async ({ page }) => {
  await signUp(page, USER_A)
  await expect(page.getByText('No sheets yet')).toBeVisible()

  await signOut(page)
  await submitSignIn(page, { ...USER_A, password: 'e2e-wrong-password' })
  await expect(page.getByRole('alert')).toHaveText('Invalid login credentials')
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()

  await signIn(page, USER_A)
  await expect(page.getByText('No sheets yet')).toBeVisible()

  // The session survives a reload.
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Your sheets' })).toBeVisible()
  await expect(page.getByText(USER_A.email)).toBeVisible()
})

test("a second user sees none of the first user's sheets", async ({ page }) => {
  await signUp(page, USER_A)
  await createScheduleSheet(page)
  await page.getByRole('button', { name: 'Back to sheets' }).click()
  const sheetButton = page.getByRole('button', { name: /^Project schedule/ })
  await expect(sheetButton).toHaveCount(1)

  await signOut(page)
  await signUp(page, USER_B)
  await expect(page.getByText('No sheets yet')).toBeVisible()
  await expect(sheetButton).toHaveCount(0)

  await signOut(page)
  await signIn(page, USER_A)
  await expect(sheetButton).toHaveCount(1)
  await expect(page.getByText('No sheets yet')).toHaveCount(0)
})
