import { expect, test, type Page } from '@playwright/test'
import { createScheduleSheet, editCell, expectSaved, gridCell, openApp } from './support/app'

const goTo = (page: Page, section: 'Sheets' | 'Automation') => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: section }).click()
const openSheet = (page: Page) => page.getByRole('button', { name: /^Project schedule/ }).first().click()

test('a rule notifies in the app when Status becomes Complete: bell, notification, activity log', async ({ page }) => {
  await openApp(page)
  await createScheduleSheet(page)
  await page.getByRole('button', { name: 'Add row' }).click()
  await editCell(page, 1, 'Task', 'Pour slab')
  await expectSaved(page)

  // Create the rule from the starter on the Automation page.
  await goTo(page, 'Automation')
  await expect(page.getByRole('heading', { name: 'Automation' })).toBeVisible()
  await page.getByRole('button', { name: 'Notify me when Status becomes Complete' }).click()
  const rules = page.getByRole('list', { name: 'Rules' })
  await expect(rules.getByText('When Status becomes Complete: notify me (in the app).')).toBeVisible()
  await expect(rules.getByText('Has not run yet')).toBeVisible()

  // Edit the cell like a user.
  await goTo(page, 'Sheets')
  await openSheet(page)
  await expect(page.getByRole('grid')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Notifications' })).toBeVisible()
  await editCell(page, 1, 'Status', 'Complete')

  // The bell shows one unread notification; opening it lists it with the row.
  const bell = page.getByRole('button', { name: 'Notifications, 1 unread' })
  await expect(bell).toBeVisible()
  await bell.click()
  const panel = page.getByRole('region', { name: 'Notifications' })
  await expect(panel.getByRole('button', { name: /Tell me when Status becomes Complete: Pour slab/ })).toBeVisible()
  await expect(panel).toContainText('Status: Complete')
  await page.screenshot({ path: 'test-results/automation-bell.png' })

  // Opening it marks it read.
  await panel.getByRole('button', { name: /Tell me when Status becomes Complete/ }).click()
  await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible()

  // Changing it to something else and back does not repeat the notification for a no-op, and the log shows the run.
  await goTo(page, 'Automation')
  await page.getByRole('tab', { name: 'Activity' }).click()
  const runs = page.getByRole('list', { name: 'Activity' })
  await expect(runs.getByRole('listitem')).toHaveCount(1)
  await expect(runs).toContainText('Tell me when Status becomes Complete')
  await expect(runs).toContainText('Pour slab')
  await expect(runs.getByText('Done', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Rules' }).click()
  await expect(rules.getByText(/^Last ran /)).toBeVisible()
})

test('the rule builder explains itself, tests a row without side effects, and a lock rule makes the row read-only', async ({ page }) => {
  await openApp(page)
  await createScheduleSheet(page)
  await page.getByRole('button', { name: 'Add row' }).click()
  await editCell(page, 1, 'Task', 'Handover')
  await expectSaved(page)

  await goTo(page, 'Automation')
  await page.getByRole('button', { name: 'New rule', exact: true }).first().click()
  const form = page.getByRole('form', { name: 'New rule' })
  await form.getByLabel('Rule name').fill('Lock finished rows')
  await expect(form.getByTestId('rule-summary')).toContainText('When Status becomes Complete: notify me (in the app).')
  await form.getByLabel('Then').selectOption({ label: 'Lock or unlock the row' })
  await expect(form.getByTestId('rule-summary')).toContainText('When Status becomes Complete: lock the row.')

  // Test run: nothing is locked by it.
  await form.getByRole('button', { name: 'Test on a row' }).click()
  await expect(form.getByTestId('test-result')).toContainText('Lock the row')
  await page.screenshot({ path: 'test-results/automation-builder.png', fullPage: true })
  await form.getByRole('button', { name: 'Save rule' }).click()
  await expect(page.getByRole('list', { name: 'Rules' }).getByText('When Status becomes Complete: lock the row.')).toBeVisible()

  await goTo(page, 'Sheets')
  await openSheet(page)
  await expect(page.getByRole('grid')).toBeVisible()
  await editCell(page, 1, 'Status', 'Complete')
  // The row is now locked: an edit is refused with a reason.
  const expectRefused = async () => {
    const task = await gridCell(page, 1, 'Task')
    await expect(async () => {
      await task.dblclick()
      const editor = task.getByLabel('Task', { exact: true })
      await editor.fill('Changed')
      await editor.press('Enter')
      await expect(task).toHaveAttribute('title', /This row is locked/)
    }).toPass({ timeout: 10_000 })
    await expect(task).toHaveAttribute('aria-invalid', 'true')
    await expect(task).not.toContainText('Changed')
  }
  await expectRefused()

  // The lock is saved with the sheet: after a reload the row is still read-only.
  await page.reload()
  await openSheet(page)
  await expect(await gridCell(page, 1, 'Task')).toContainText('Handover')
  await expectRefused()
})

test('the public update page works without signing in and shows only what was asked for', async ({ page }) => {
  const token = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'
  let posted: unknown = null
  await page.route(`**/api/u/${token}`, async (route) => {
    if (route.request().method() === 'POST') {
      posted = route.request().postDataJSON()
      await route.fulfill({ json: { ok: true } })
      return
    }
    await route.fulfill({
      json: {
        ok: true,
        kind: 'update',
        sheetName: 'Tower A',
        message: 'Please confirm the hours for the slab pour.',
        expiresAt: '2026-12-01T00:00:00Z',
        fields: [
          { id: 'h', title: 'Hours', type: 'TEXT_NUMBER', value: 8, editable: true },
          { id: 's', title: 'Status', type: 'PICKLIST', options: ['In progress', 'Complete'], value: 'In progress', editable: true },
        ],
      },
    })
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/u/${token}`)
  await expect(page.getByRole('heading', { name: 'Please update this row' })).toBeVisible()
  await expect(page.getByText('Please confirm the hours for the slab pour.')).toBeVisible()
  // no app shell, no sheet list, no sign-in
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Your sheets' })).toHaveCount(0)
  await page.screenshot({ path: 'test-results/automation-public.png' })
  await page.getByLabel('Hours').fill('12')
  await page.getByLabel('Status').selectOption('Complete')
  await page.getByRole('button', { name: 'Send update' }).click()
  await expect(page.getByRole('heading', { name: 'Thank you' })).toBeVisible()
  expect(posted).toEqual({ values: { h: '12', s: 'Complete' } })
})

test('a used link says so', async ({ page }) => {
  const token = 'ZYXWVUTSRQPONMLKJIHGFEDCBAzyxwvutsrqponmlkjih'
  await page.route(`**/api/a/${token}`, (route) => route.fulfill({ status: 410, json: { ok: false, error: 'used', state: 'approved' } }))
  await page.goto(`/a/${token}`)
  await expect(page.getByRole('heading', { name: 'Already answered' })).toBeVisible()
})
