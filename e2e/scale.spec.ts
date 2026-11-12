import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { generateNKeysBetween } from 'fractional-indexing'
import { columnToDb } from '../src/store/persistence'
import { createSheetFromTemplate } from '../src/templates'
import { addUser, emptyState, FAKE_STORAGE_KEY, type DbRecord } from './support/fakeSupabase'
import { expectNoPageScroll, openTab, USER_A } from './support/app'

const ROWS = 3000
const SCREENSHOTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'screenshots')

/** Backend state: USER_A signed in, owning one project-schedule sheet with ROWS scheduled tasks. */
function seedState(): string {
  const state = emptyState()
  const user = addUser(state, USER_A.email, USER_A.password)
  state.sessionUserId = user.id
  const { sheet, columns } = createSheetFromTemplate('project-schedule', user.id)
  const col = (title: string) => columns.find((c) => c.title === title)!.id
  const owner = { sheet_id: sheet.id, owner_id: user.id, workspace_id: sheet.workspaceId }
  state.tables.sheets.push({
    id: sheet.id,
    owner_id: user.id,
    workspace_id: sheet.workspaceId,
    name: 'Big schedule',
    calendar: sheet.calendar,
    dependencies_enabled: sheet.dependenciesEnabled,
    created_at: new Date().toISOString(),
  })
  state.tables.columns.push(...columns.map((c, i) => columnToDb(c, i, sheet) as unknown as DbRecord))
  const positions = generateNKeysBetween(null, null, ROWS)
  const day0 = Date.UTC(2026, 10, 9)
  for (let i = 0; i < ROWS; i++) {
    const start = new Date(day0 + (i % 90) * 86_400_000).toISOString().slice(0, 10)
    state.tables.rows.push({
      id: crypto.randomUUID(),
      ...owner,
      parent_id: null,
      position: positions[i],
      cells: {
        [col('Task')]: `Task ${i + 1}`,
        [col('Duration')]: `${(i % 5) + 1}d`,
        [col('Start')]: start,
        [col('Status')]: i % 3 === 0 ? 'Complete' : 'In progress',
      },
      version: 0,
    })
  }
  return JSON.stringify(state)
}

test('a 3,000-row sheet stays virtualized in a real browser and the page never scrolls', async ({ page }) => {
  test.setTimeout(120_000)
  mkdirSync(SCREENSHOTS, { recursive: true })
  await page.addInitScript(
    ([key, json]) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, json)
    },
    [FAKE_STORAGE_KEY, seedState()] as const,
  )

  await page.goto('/')
  await page.getByRole('button', { name: /^Big schedule/ }).click()
  const grid = page.getByRole('grid')
  await expect(grid).toHaveAttribute('aria-rowcount', String(ROWS + 1))
  await expect(page.getByText('Task 1', { exact: true })).toBeVisible()

  // Grid: only a window of rows is in the DOM.
  const rendered = await grid.getByRole('row').count()
  expect(rendered).toBeGreaterThan(5)
  expect(rendered).toBeLessThan(200)
  await expectNoPageScroll(page)

  // The grid scrolls inside its own pane down to the last row.
  const scroller = grid.locator('..')
  const box = await scroller.evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight }))
  expect(box.client).toBeLessThan(box.scroll)
  await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
  await expect(page.getByText(`Task ${ROWS}`, { exact: true })).toBeVisible()
  expect(await grid.getByRole('row').count()).toBeLessThan(200)
  await expectNoPageScroll(page)
  await page.screenshot({ path: path.join(SCREENSHOTS, 'grid.png'), fullPage: true })

  // Gantt: a window of bars, not 3,000.
  await openTab(page, 'Gantt')
  const bars = page.getByRole('img', { name: /^Task \d+: / })
  await expect(bars.first()).toBeVisible()
  const barCount = await bars.count()
  expect(barCount).toBeGreaterThan(5)
  expect(barCount).toBeLessThan(200)
  await expectNoPageScroll(page)
  await page.screenshot({ path: path.join(SCREENSHOTS, 'gantt.png'), fullPage: true })

  // Kanban: lanes page their cards and scroll inside the board.
  await openTab(page, 'Kanban')
  await expect(page.getByRole('region', { name: `Complete (${ROWS / 3})` })).toBeVisible()
  await expectNoPageScroll(page)
  await page.screenshot({ path: path.join(SCREENSHOTS, 'kanban.png'), fullPage: true })
})
