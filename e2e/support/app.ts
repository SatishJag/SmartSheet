import { expect, type Locator, type Page } from '@playwright/test'

/** Obviously fake test accounts; they exist only in the browser's fake backend. */
export const USER_A = { email: 'e2e-user-a@example.com', password: 'e2e-password-a' }
export const USER_B = { email: 'e2e-user-b@example.com', password: 'e2e-password-b' }

export type User = typeof USER_A

/** Creates an account through the app's own form; ends on the (empty) sheet list. */
export async function signUp(page: Page, user: User): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Create account' }).click() // switch the form to sign-up
  await expect(page.getByRole('heading', { name: 'Create account' })).toBeVisible()
  await page.getByLabel('Email').fill(user.email)
  await page.getByLabel('Password').fill(user.password)
  await page.getByRole('button', { name: 'Create account', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Your sheets' })).toBeVisible()
  await expect(page.getByText(user.email)).toBeVisible()
}

/** Fills and submits the sign-in form (which must be showing). */
export async function submitSignIn(page: Page, user: User): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await page.getByLabel('Email').fill(user.email)
  await page.getByLabel('Password').fill(user.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}

export async function signIn(page: Page, user: User): Promise<void> {
  await submitSignIn(page, user)
  await expect(page.getByRole('heading', { name: 'Your sheets' })).toBeVisible()
}

export async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
}

/** Creates a sheet from the "Project schedule" template; ends inside the new sheet's grid. */
export async function createScheduleSheet(page: Page): Promise<void> {
  await page.getByLabel('Template').selectOption({ label: 'Project schedule' })
  await page.getByRole('button', { name: 'New sheet' }).click()
  await expect(page.getByRole('heading', { name: 'Project schedule' })).toBeVisible()
  await expect(page.getByRole('grid')).toBeVisible()
}

export async function openTab(page: Page, name: 'Grid' | 'Gantt' | 'Kanban'): Promise<void> {
  const tab = page.getByRole('tab', { name })
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
}

/** Waits until every edit has been written to the backend. */
export async function expectSaved(page: Page): Promise<void> {
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
}

/** The grid's column header whose sort button is labelled `title`. */
function columnHeader(page: Page, title: string): Locator {
  return page.getByRole('columnheader').filter({ has: page.getByRole('button', { name: title, exact: true }) })
}

/** A grid cell by 1-based row number (display order) and column title. */
export async function gridCell(page: Page, rowNumber: number, title: string): Promise<Locator> {
  const header = columnHeader(page, title)
  await expect(header).toHaveCount(1)
  const colIndex = await header.getAttribute('aria-colindex')
  // aria-rowindex 1 is the header row, so data row n is n + 1.
  return page
    .getByRole('grid')
    .getByRole('row')
    .and(page.locator(`[aria-rowindex="${rowNumber + 1}"]`))
    .getByRole('gridcell')
    .and(page.locator(`[aria-colindex="${colIndex}"]`))
}

/**
 * Edits a cell like a user: double-click to open its editor, then type and press Enter (or pick
 * the option, for a dropdown column).
 */
export async function editCell(page: Page, rowNumber: number, title: string, value: string): Promise<Locator> {
  const cell = await gridCell(page, rowNumber, title)
  await cell.dblclick()
  const editor = cell.getByLabel(title, { exact: true })
  await expect(editor).toBeFocused()
  const tag = await editor.evaluate((el) => el.tagName)
  if (tag === 'SELECT') {
    await editor.selectOption({ label: value })
  } else {
    await editor.fill(value)
    await editor.press('Enter')
  }
  await expect(editor).toHaveCount(0)
  return cell
}

/** A Gantt bar (task, milestone or summary) by its task name. */
export function ganttBar(page: Page, name: string): Locator {
  return page.getByRole('img', { name: new RegExp(`^${escapeRegExp(name)}: `) })
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Asserts the page itself does not scroll vertically: the views must scroll inside their own panes. */
export async function expectNoPageScroll(page: Page): Promise<void> {
  const { scrollHeight, innerHeight } = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
  }))
  expect(scrollHeight, 'document height vs viewport height').toBeLessThanOrEqual(innerHeight + 2)
}
