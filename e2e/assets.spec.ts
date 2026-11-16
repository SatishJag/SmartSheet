import { expect, test, type Page } from '@playwright/test'
import { createScheduleSheet, editCell, expectSaved, gridCell, openApp } from './support/app'

/** The section buttons of the main navigation, by position (on a phone only the active one shows its label). */
const SECTION = { Sheets: 0, Workspaces: 1, Reports: 2, Dashboards: 3 } as const

async function goTo(page: Page, section: keyof typeof SECTION): Promise<void> {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button').nth(SECTION[section]).click()
}

async function createSheet(page: Page, template: 'Project schedule' | 'Simple list', rows: [string, string][]): Promise<void> {
  await page.getByRole('radio', { name: template }).check()
  await page.getByRole('button', { name: 'New sheet' }).click()
  await expect(page.getByRole('heading', { name: template })).toBeVisible()
  for (const [i, [task, status]] of rows.entries()) {
    await page.getByRole('button', { name: 'Add row' }).click()
    await editCell(page, i + 1, 'Task', task)
    await editCell(page, i + 1, 'Status', status)
  }
  await expectSaved(page)
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow, 'page-level horizontal scroll').toBeLessThanOrEqual(0)
}

test('reports, dashboards and workspaces over two sheets, end to end', async ({ page }) => {
  await openApp(page)
  await createScheduleSheet(page)
  for (const [i, [task, status]] of [['Pour footings', 'In progress'], ['Frame walls', 'Not started']].entries()) {
    await page.getByRole('button', { name: 'Add row' }).click()
    await editCell(page, i + 1, 'Task', task)
    await editCell(page, i + 1, 'Status', status)
  }
  await expectSaved(page)
  await goTo(page, 'Sheets')
  await createSheet(page, 'Simple list', [['Order lumber', 'In progress'], ['Hang doors', 'Complete']])
  await goTo(page, 'Sheets')

  // ---- a report over both sheets, filtered to work in progress ----
  await goTo(page, 'Reports')
  await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible()
  await page.getByRole('button', { name: 'New report' }).click()
  await page.getByRole('dialog', { name: 'New report' }).getByRole('textbox').fill('Active work')
  await page.getByRole('button', { name: 'Create and set up' }).click()
  await page.getByRole('checkbox', { name: 'Project schedule' }).check()
  await page.getByRole('checkbox', { name: 'Simple list' }).check()
  await expect(page.getByText('4 rows match. Showing the first 50.')).toBeVisible()
  await page.getByRole('button', { name: 'Add filter' }).click()
  await page.getByLabel('Filter 1 column').selectOption({ label: 'Status' })
  await page.getByLabel('Filter 1 value').selectOption('In progress')
  await expect(page.getByText('2 rows match. Showing the first 50.')).toBeVisible()
  await page.getByRole('button', { name: 'Save report' }).click()
  await expect(page.getByText(/2 of 4 rows from 2 sheets/)).toBeVisible()

  const grid = page.getByRole('grid', { name: 'Active work rows' })
  await expect(grid.getByRole('row').filter({ hasText: 'Pour footings' })).toBeVisible()
  await expect(grid.getByRole('row').filter({ hasText: 'Order lumber' })).toBeVisible()
  await expect(grid.getByRole('row').filter({ hasText: 'Frame walls' })).toHaveCount(0) // not in progress

  // ---- edit in place: the value is written to the source sheet ----
  await grid.getByRole('row').filter({ hasText: 'Pour footings' }).getByRole('gridcell', { name: /Pour footings/ }).click()
  const taskEditor = page.getByRole('textbox', { name: /^Task, Project schedule row 1/ })
  await taskEditor.fill('Pour footings, east wing')
  await taskEditor.press('Enter')
  await expect(grid.getByRole('row').filter({ hasText: 'Pour footings, east wing' })).toBeVisible()

  // Completing "Order lumber" in the report removes it from the filtered report.
  await grid.getByRole('row').filter({ hasText: 'Order lumber' }).getByRole('gridcell', { name: /In progress/ }).click()
  await page.getByRole('combobox', { name: /^Status, Simple list row 1/ }).selectOption('Complete')
  await page.keyboard.press('Enter')
  await expect(grid.getByRole('row').filter({ hasText: 'Order lumber' })).toHaveCount(0)
  await expect(page.getByText(/1 of 4 rows from 2 sheets/)).toBeVisible()
  await expectNoHorizontalScroll(page)

  // The source sheets show the new values (follow the Sheet link of a row).
  await grid.getByRole('row').filter({ hasText: 'Pour footings, east wing' }).getByRole('button', { name: 'Project schedule' }).click()
  await expect(page.getByRole('heading', { name: 'Project schedule' })).toBeVisible()
  await expect(await gridCell(page, 1, 'Task')).toHaveText('Pour footings, east wing')
  await goTo(page, 'Sheets')
  await page.getByRole('button', { name: /^Simple list/ }).click()
  await expect(await gridCell(page, 1, 'Status')).toHaveText('Complete')
  await goTo(page, 'Sheets')

  // ---- a dashboard with a metric over the report and a chart over a sheet ----
  await goTo(page, 'Dashboards')
  await page.getByRole('button', { name: 'New dashboard' }).click()
  await page.getByRole('dialog', { name: 'New dashboard' }).getByRole('textbox').fill('Site board')
  await page.getByRole('button', { name: 'Create' }).click()

  await page.getByRole('button', { name: 'Add widget' }).click()
  await page.getByRole('menuitem', { name: 'Metric' }).click()
  let dialog = page.getByRole('dialog', { name: 'Metric settings' })
  await dialog.getByLabel('Widget title (optional)').fill('Active tasks')
  await dialog.getByLabel('Data from').selectOption({ label: 'Active work' })
  await dialog.getByRole('button', { name: 'Apply' }).click()
  await expect(page.getByRole('listitem', { name: 'Active tasks' }).getByRole('status')).toHaveText('1')

  await page.getByRole('button', { name: 'Add widget' }).click()
  await page.getByRole('menuitem', { name: 'Chart' }).click()
  dialog = page.getByRole('dialog', { name: 'Chart settings' })
  await dialog.getByLabel('Widget title (optional)').fill('Tasks by status')
  await dialog.getByLabel('Data from').selectOption({ label: 'Project schedule' })
  await dialog.getByLabel('Group by (categories)').selectOption({ label: 'Status' })
  await dialog.getByRole('button', { name: 'Apply' }).click()
  const chart = page.getByRole('listitem', { name: 'Tasks by status' })
  await expect(chart.getByRole('img', { name: /Tasks by status: column chart of 2 values/ })).toBeVisible()
  await expectNoHorizontalScroll(page)
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByRole('button', { name: 'Add widget' })).toHaveCount(0)
  // The layout was saved: it is still there after a reload.
  await page.reload()
  await goTo(page, 'Dashboards')
  await page.locator('.asset-card-main', { hasText: 'Site board' }).click()
  await expect(page.getByRole('listitem', { name: 'Active tasks' })).toBeVisible()
  await expect(page.getByRole('listitem', { name: 'Tasks by status' })).toBeVisible()

  // ---- organise everything into a workspace ----
  await goTo(page, 'Workspaces')
  await page.getByRole('button', { name: 'New workspace' }).click()
  await page.getByRole('dialog', { name: 'New workspace' }).getByRole('textbox').fill('Riverside')
  await page.getByRole('dialog', { name: 'New workspace' }).getByRole('button', { name: 'Create' }).click()
  await page.getByRole('button', { name: 'Add to Riverside' }).click()
  await page.getByRole('menuitem', { name: 'New folder' }).click()
  await page.getByRole('dialog', { name: 'New folder' }).getByRole('textbox').fill('Reporting')
  await page.getByRole('dialog', { name: 'New folder' }).getByRole('button', { name: 'Create' }).click()

  for (const name of ['Active work', 'Site board']) {
    await page.getByRole('button', { name: `Actions for ${name}` }).click()
    await page.getByRole('menuitem', { name: 'Move to workspace…' }).click()
    await page.getByRole('dialog', { name: `Move "${name}"` }).getByRole('combobox').selectOption({ label: 'Reporting' })
    await page.getByRole('dialog', { name: `Move "${name}"` }).getByRole('button', { name: 'Move' }).click()
  }
  const workspace = page.getByRole('region', { name: 'Riverside' })
  await expect(workspace.getByRole('button', { name: 'Active work Report' })).toBeVisible()
  await expect(workspace.getByRole('button', { name: 'Site board Dashboard' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Not in a workspace' }).getByRole('button', { name: 'Active work Report' })).toHaveCount(0)

  // Star the dashboard, find things by name, and everything survives a reload.
  await page.getByRole('button', { name: 'Add Site board to favorites' }).click()
  await expect(page.getByRole('region', { name: 'Favorites' }).getByRole('button', { name: /Site board/ })).toBeVisible()
  await page.getByRole('searchbox').fill('active')
  await expect(page.getByRole('region', { name: 'Search results' }).getByRole('button', { name: /^Active work Riverside/ })).toBeVisible()
  await page.getByRole('searchbox').fill('')
  await page.reload()
  await goTo(page, 'Workspaces')
  await expect(page.getByRole('region', { name: 'Riverside' }).getByRole('button', { name: 'Site board Dashboard' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Favorites' })).toBeVisible()
  await expectNoHorizontalScroll(page)
})

test('every assets page fits a phone without horizontal page scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openApp(page)
  await createScheduleSheet(page)
  await page.getByRole('button', { name: 'Add row' }).click()
  await editCell(page, 1, 'Task', 'Pour footings')
  await expectSaved(page)
  await goTo(page, 'Sheets')

  await goTo(page, 'Workspaces')
  await page.getByRole('button', { name: 'New workspace' }).click()
  await page.getByRole('dialog', { name: 'New workspace' }).getByRole('textbox').fill('A workspace with a rather long name to test wrapping')
  await page.getByRole('dialog', { name: 'New workspace' }).getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('region', { name: /A workspace with/ })).toBeVisible()
  await expectNoHorizontalScroll(page)

  await goTo(page, 'Reports')
  await page.getByRole('button', { name: 'New report' }).click()
  await page.getByRole('dialog', { name: 'New report' }).getByRole('textbox').fill('Phone report')
  await page.getByRole('button', { name: 'Create and set up' }).click()
  await page.getByRole('checkbox', { name: 'Project schedule' }).check()
  await expect(page.getByText(/rows match/)).toBeVisible()
  await expectNoHorizontalScroll(page)
  await page.getByRole('button', { name: 'Save report' }).click()
  await expect(page.getByRole('grid', { name: 'Phone report rows' })).toBeVisible()
  await expectNoHorizontalScroll(page)

  await goTo(page, 'Dashboards')
  await page.getByRole('button', { name: 'New dashboard' }).click()
  await page.getByRole('dialog', { name: 'New dashboard' }).getByRole('textbox').fill('Phone board')
  await page.getByRole('button', { name: 'Create' }).click()
  await page.getByRole('button', { name: 'Add widget' }).click()
  await page.getByRole('menuitem', { name: 'Text' }).click()
  await page.getByRole('dialog', { name: 'Text settings' }).getByLabel('Text').fill('# Hello\n\n- one\n- two')
  await page.getByRole('dialog', { name: 'Text settings' }).getByRole('button', { name: 'Apply' }).click()
  await expect(page.getByRole('heading', { name: 'Hello' })).toBeVisible()
  await expectNoHorizontalScroll(page)
})

test('a widget is dragged by its handle and resized by its corner, snapping to the grid', async ({ page }) => {
  await openApp(page)
  await goTo(page, 'Dashboards')
  await page.getByRole('button', { name: 'New dashboard' }).click()
  await page.getByRole('dialog', { name: 'New dashboard' }).getByRole('textbox').fill('Drag test')
  await page.getByRole('button', { name: 'Create' }).click()
  await page.getByRole('button', { name: 'Add widget' }).click()
  await page.getByRole('menuitem', { name: 'Text' }).click()
  await page.getByRole('dialog', { name: 'Text settings' }).getByLabel('Widget title (optional)').fill('Notes')
  await page.getByRole('dialog', { name: 'Text settings' }).getByRole('button', { name: 'Apply' }).click()

  const widget = page.getByRole('listitem', { name: 'Notes' })
  const settings = async () => {
    await page.getByRole('button', { name: 'Settings for Notes' }).click()
    const dialog = page.getByRole('dialog', { name: 'Text settings' })
    const read = async (label: string) => Number(await dialog.getByLabel(label, { exact: true }).inputValue())
    const values = { x: await read('Grid column'), y: await read('Grid row'), w: await read('Width'), h: await read('Height') }
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    return values
  }
  expect(await settings()).toEqual({ x: 1, y: 1, w: 4, h: 3 })

  const grip = widget.getByRole('button', { name: /^Move Notes/ })
  const g = (await grip.boundingBox())!
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2)
  await page.mouse.down()
  await page.mouse.move(g.x + g.width / 2 + 100, g.y + g.height / 2 + 40, { steps: 6 })
  await page.mouse.move(g.x + g.width / 2 + 240, g.y + g.height / 2 + 120, { steps: 6 })
  await page.mouse.up()
  const moved = await settings()
  expect(moved.x).toBeGreaterThan(2) // 240px is about two and a half columns on a 1280px page
  expect(moved.y).toBeGreaterThan(1)

  const corner = widget.locator('.dash-resize')
  const c = (await corner.boundingBox())!
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2)
  await page.mouse.down()
  await page.mouse.move(c.x + 200, c.y + 150, { steps: 8 })
  await page.mouse.up()
  const resized = await settings()
  expect(resized.w).toBeGreaterThan(4)
  expect(resized.h).toBeGreaterThan(3)
  expect(resized.x + resized.w - 1).toBeLessThanOrEqual(12) // never leaves the 12-column grid

  // Saved: still there after a reload.
  await page.getByRole('button', { name: 'Done' }).click()
  await page.reload()
  await goTo(page, 'Dashboards')
  await page.locator('.asset-card-main', { hasText: 'Drag test' }).click()
  await page.getByRole('button', { name: 'Edit dashboard' }).click()
  expect(await settings()).toEqual(resized)
})
