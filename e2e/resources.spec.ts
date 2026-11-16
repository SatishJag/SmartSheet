import { expect, test, type Locator, type Page } from '@playwright/test'
import { createScheduleSheet, editCell, expectSaved, openApp } from './support/app'

/** The Monday `weeks` weeks after the current week, as YYYY-MM-DD (local time, like the app). */
function mondayIn(weeks: number): string {
  const d = new Date()
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + weeks * 7)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const nav = (page: Page, name: 'Sheets' | 'Resources') => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name }).click()

async function addResource(page: Page, name: string, department: string) {
  await page.getByRole('button', { name: /^Add (your first )?resource$/ }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Add resource' })
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByLabel('Department').fill(department)
  await dialog.getByLabel('Cost rate per hour').fill('60')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('heading', { name })).toBeVisible()
}

/** Picks a resource in the assign panel by name (the option text also carries its free hours). */
async function chooseResource(panel: Locator, name: string) {
  const value = await panel.getByRole('combobox', { name: 'Resource' }).locator('option', { hasText: name }).getAttribute('value')
  await panel.getByRole('combobox', { name: 'Resource' }).selectOption(value!)
}

/** The workload cell of a resource in the week starting `monday`, after going to that date. */
async function weekCell(page: Page, resource: string, monday: string) {
  await page.getByLabel('Go to date').fill(monday)
  const row = page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: new RegExp(resource) }) })
  return row.getByRole('gridcell').first()
}

test('resources: create, assign on a project sheet, see the load, over-allocate, and follow a moved task', async ({ page }) => {
  const week1 = mondayIn(1)
  const week2 = mondayIn(2)

  // 1. Two resources on the Resources page.
  await openApp(page)
  await nav(page, 'Resources')
  await expect(page.getByRole('heading', { name: 'Resources', level: 1 })).toBeVisible()
  await expect(page.getByText('No resources yet')).toBeVisible()
  await page.getByRole('tab', { name: 'Resources' }).click()
  await addResource(page, 'Ada Okafor', 'Electrical')
  await addResource(page, 'Ben Hartley', 'Site management')
  await expect(page.getByRole('list', { name: 'Resource list' }).getByRole('listitem')).toHaveCount(2)
  await expect(page.getByText('40 h/week').first()).toBeVisible()

  // 2. A project sheet with two 3-day tasks starting the same Monday.
  await nav(page, 'Sheets')
  await createScheduleSheet(page)
  const addRow = page.getByRole('button', { name: 'Add row' })
  await addRow.click()
  await addRow.click()
  for (const [i, name] of ['Pour slab', 'Fix conduit'].entries()) {
    await editCell(page, i + 1, 'Task', name)
    await editCell(page, i + 1, 'Start', week1)
    await editCell(page, i + 1, 'Duration', '3d')
  }
  await expectSaved(page)

  // 3. Assign Ada to the first task: within capacity. Then to the second: over-allocated warning.
  await page.getByRole('button', { name: 'Assign resources' }).click()
  const panel = page.getByRole('complementary')
  await expect(panel.getByRole('heading', { name: 'Assign resources' })).toBeVisible()
  await panel.getByRole('checkbox', { name: /^Pour slab/ }).check()
  await chooseResource(panel, 'Ada Okafor')
  await expect(panel.getByText('Within capacity.')).toBeVisible()
  await panel.getByRole('button', { name: 'Assign to task' }).click()
  await expect(panel.getByText('Ada Okafor is assigned to Pour slab.')).toBeVisible()
  await expect(panel.getByLabel('Assigned: Ada Okafor')).toBeVisible()

  await panel.getByRole('checkbox', { name: /^Pour slab/ }).uncheck()
  await panel.getByRole('checkbox', { name: /^Fix conduit/ }).check()
  await chooseResource(panel, 'Ada Okafor')
  const warning = panel.getByRole('status').filter({ hasText: 'Over-allocated' })
  await expect(warning).toContainText('over capacity on 3 days')
  await expect(panel.getByRole('list', { name: 'Weekly load with this assignment' })).toContainText('! 48/40')
  await panel.getByRole('button', { name: 'Assign to task' }).click()
  await expect(panel.getByText('Ada Okafor is assigned to Fix conduit.')).toBeVisible()
  await panel.getByRole('button', { name: 'Close' }).click()
  await expect(panel).toHaveCount(0)

  // 4. The heat map shows Ada over-allocated that week, with the tasks behind the number.
  await nav(page, 'Resources')
  const ada1 = await weekCell(page, 'Ada Okafor', week1)
  await expect(ada1).toHaveAttribute('data-level', 'over')
  await expect(ada1).toContainText('48')
  await expect(ada1).toContainText('!')
  await expect(page.getByLabel('Utilisation summary').getByText('Over-allocated').locator('xpath=following-sibling::dd')).toHaveText('1')
  await ada1.click()
  const detail = page.getByRole('complementary')
  await expect(detail.getByText('48 of 40 h')).toBeVisible()
  await expect(detail.getByText('Pour slab')).toBeVisible()
  await expect(detail.getByText('Fix conduit')).toBeVisible()
  await page.keyboard.press('Escape')
  const ben1 = await weekCell(page, 'Ben Hartley', week1)
  await expect(ben1).toHaveAttribute('data-level', 'none')

  // Over-allocated only filters the map to Ada.
  await page.getByRole('checkbox', { name: 'Over-allocated only' }).check()
  await expect(page.getByRole('rowheader')).toHaveCount(1)
  await page.getByRole('checkbox', { name: 'Over-allocated only' }).uncheck()

  // Find a resource: Ben fits, Ada does not.
  await page.getByRole('tab', { name: 'Find a resource' }).click()
  await page.getByLabel('From').fill(week1)
  await page.getByLabel('To').fill(week1)
  const results = page.getByRole('list', { name: 'Results' })
  await expect(results.getByRole('listitem').first()).toContainText('Ben Hartley')
  await expect(results.getByRole('listitem').first()).toContainText('Fits')
  await expect(results.getByRole('listitem').last()).toContainText('Does not fit')

  // 5. Move "Fix conduit" a week later in the sheet: the assignment follows the task.
  await nav(page, 'Sheets')
  await page.getByRole('button', { name: /^Project schedule/ }).click()
  await expect(page.getByRole('grid')).toBeVisible()
  await editCell(page, 2, 'Start', week2)
  await expectSaved(page)
  await nav(page, 'Resources')
  const ada1b = await weekCell(page, 'Ada Okafor', week1)
  await expect(ada1b).not.toHaveAttribute('data-level', 'over')
  await expect(ada1b).toContainText('24')
  const row = page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: /Ada Okafor/ }) })
  await expect(row.getByRole('gridcell').nth(1)).toContainText('24') // the following week

  // Nothing is lost on reload.
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Your sheets' })).toBeVisible()
  await nav(page, 'Resources')
  await expect(page.getByRole('grid', { name: 'Workload by resource' })).toBeVisible()
  await expect(page.getByRole('rowheader', { name: /Ada Okafor/ })).toBeVisible()
})

test('resources: leveling suggests moving a task with float, and the page fits a phone', async ({ page }) => {
  const week1 = mondayIn(1)
  await openApp(page)
  await nav(page, 'Resources')
  await page.getByRole('tab', { name: 'Resources' }).click()
  await addResource(page, 'Ada Okafor', 'Electrical')

  await nav(page, 'Sheets')
  await createScheduleSheet(page)
  // Dependencies on: Task 1 -> Task 3 is the long chain, Task 2 floats beside it.
  await page.getByRole('button', { name: 'Schedule settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Schedule settings' })
  if (!(await dialog.getByRole('checkbox', { name: /dependencies/i }).isChecked())) await dialog.getByRole('checkbox', { name: /dependencies/i }).check()
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toHaveCount(0)
  const addRow = page.getByRole('button', { name: 'Add row' })
  for (let i = 0; i < 3; i++) await addRow.click()
  await editCell(page, 1, 'Task', 'Task 1')
  await editCell(page, 1, 'Start', week1)
  await editCell(page, 1, 'Duration', '3d')
  await editCell(page, 2, 'Task', 'Task 2')
  await editCell(page, 2, 'Start', week1)
  await editCell(page, 2, 'Duration', '3d')
  await editCell(page, 3, 'Task', 'Task 3')
  await editCell(page, 3, 'Duration', '8d')
  await editCell(page, 3, 'Predecessors', '1')
  await expectSaved(page)

  await page.getByRole('button', { name: 'Assign resources' }).click()
  const panel = page.getByRole('complementary')
  for (const t of ['Task 1', 'Task 2']) {
    await panel.getByRole('checkbox', { name: new RegExp(`^${t}`) }).check()
  }
  await chooseResource(panel, 'Ada Okafor')
  await panel.getByRole('button', { name: 'Assign to 2 tasks' }).click()
  await expect(panel.getByText('Ada Okafor is assigned to 2 tasks.')).toBeVisible()
  await panel.getByRole('button', { name: 'Close' }).click()

  await nav(page, 'Resources')
  await page.getByRole('tab', { name: 'Leveling' }).click()
  await page.getByLabel('From').fill(week1)
  await page.getByLabel('To').fill(mondayIn(8))
  await page.getByRole('button', { name: 'Find suggestions' }).click()
  const item = page.getByRole('list', { name: 'Suggestions' }).getByRole('listitem').first()
  await expect(item).toContainText('Delay “Task 2” by 3 working days')
  await expect(item).toContainText('Inside its free float')

  // A phone: the heat map scrolls inside its own box, not the page.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('tab', { name: 'Workload' }).click()
  await expect(page.getByRole('grid', { name: 'Workload by resource' })).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(1)
  await page.getByRole('tab', { name: 'Find a resource' }).click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
})
