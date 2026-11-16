import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { SheetStoreProvider } from '../store/SheetStoreContext'
import { COL, makeSheetData, makeTestStore } from '../test/fixtures'
import { ScheduleSettingsButton } from './ScheduleSettingsDialog'

async function setup(data = makeSheetData()) {
  const { store, persistence } = await makeTestStore(data)
  const user = userEvent.setup()
  render(
    <SheetStoreProvider store={store}>
      <button type="button">Before</button>
      <ScheduleSettingsButton />
    </SheetStoreProvider>,
  )
  return { store, persistence, user }
}

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Schedule settings' }))
  return screen.getByRole('dialog', { name: 'Schedule settings' })
}

describe('ScheduleSettingsDialog', () => {
  it('opens as a modal showing the current settings, with focus inside', async () => {
    const { user } = await setup()
    const dialog = await open(user)
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    const days = within(dialog).getByRole('group', { name: 'Working days' })
    expect(within(days).getByRole('checkbox', { name: 'Monday' })).toBeChecked()
    expect(within(days).getByRole('checkbox', { name: 'Friday' })).toBeChecked()
    expect(within(days).getByRole('checkbox', { name: 'Saturday' })).not.toBeChecked()
    expect(within(days).getByRole('checkbox', { name: 'Sunday' })).not.toBeChecked()
    expect(within(dialog).getByRole('spinbutton', { name: 'Hours per day' })).toHaveValue(8)
    expect(within(dialog).getByRole('checkbox', { name: 'Dependencies drive dates' })).toBeChecked()
    expect(within(dialog).getByText('No non-working dates')).toBeInTheDocument()
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it('Escape and Cancel close without changing anything; focus returns to the button', async () => {
    const { store, user } = await setup()
    const before = store.getState().data
    let dialog = await open(user)
    await user.click(within(dialog).getByRole('checkbox', { name: 'Saturday' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Schedule settings' })).toHaveFocus()

    dialog = await open(user)
    expect(within(dialog).getByRole('checkbox', { name: 'Saturday' })).not.toBeChecked() // edits were dropped
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(store.getState().data).toBe(before)
  })

  it('keeps Tab focus inside the dialog', async () => {
    const { user } = await setup()
    const dialog = await open(user)
    for (let i = 0; i < 20; i++) {
      await user.tab()
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
    for (let i = 0; i < 5; i++) {
      await user.tab({ shift: true })
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
  })

  it('saves weekdays, hours and non-working dates, re-running the schedule', async () => {
    const { store, persistence, user } = await setup()
    const dialog = await open(user)
    await user.click(within(dialog).getByRole('checkbox', { name: 'Saturday' }))
    const hours = within(dialog).getByRole('spinbutton', { name: 'Hours per day' })
    await user.clear(hours)
    await user.type(hours, '7.5')
    const date = within(dialog).getByLabelText('Non-working date')
    await user.type(date, '2026-11-25')
    await user.click(within(dialog).getByRole('button', { name: 'Add date' }))
    await user.type(date, '2026-11-11')
    await user.click(within(dialog).getByRole('button', { name: 'Add date' }))
    const list = within(dialog).getByRole('list', { name: 'Non-working dates' })
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('2026-11-11'),
      expect.stringContaining('2026-11-25'),
    ])
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(store.getState().data!.sheet.calendar).toEqual({
      workingWeekdays: [1, 2, 3, 4, 5, 6],
      nonWorkingDates: ['2026-11-11', '2026-11-25'],
      hoursPerDay: 7.5,
    })
    // r-clear (3d after Survey ends Tue 10th) skips Wed 11th: Thu 12th, Fri 13th, Sat 14th.
    expect(store.getState().scheduled.byRow['r-clear']).toMatchObject({ start: '2026-11-12', end: '2026-11-14' })
    await vi_waitSaved(store)
    expect(persistence.saveSheetSettings).toHaveBeenCalled()
  })

  it('removes a non-working date', async () => {
    const data = makeSheetData()
    data.sheet.calendar = { ...data.sheet.calendar, nonWorkingDates: ['2026-12-24', '2026-12-25'] }
    const { store, user } = await setup(data)
    const dialog = await open(user)
    await user.click(within(dialog).getByRole('button', { name: 'Remove 2026-12-24' }))
    expect(within(dialog).queryByText('2026-12-24')).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(store.getState().data!.sheet.calendar.nonWorkingDates).toEqual(['2026-12-25'])
  })

  it('shows validation errors inline and keeps the dialog open', async () => {
    const { store, user } = await setup()
    const before = store.getState().data
    const dialog = await open(user)
    for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']) {
      await user.click(within(dialog).getByRole('checkbox', { name: day }))
    }
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Choose at least one working day of the week')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(store.getState().data).toBe(before)

    await user.click(within(dialog).getByRole('checkbox', { name: 'Monday' }))
    const hours = within(dialog).getByRole('spinbutton', { name: 'Hours per day' })
    await user.clear(hours)
    await user.type(hours, '30')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Hours per day must be between 1 and 24')
    expect(hours).toHaveAttribute('aria-invalid', 'true')
  })

  it('does not add an empty or duplicate date', async () => {
    const { user } = await setup()
    const dialog = await open(user)
    await user.click(within(dialog).getByRole('button', { name: 'Add date' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Pick a date to add')
    const date = within(dialog).getByLabelText('Non-working date')
    await user.type(date, '2026-12-25')
    await user.click(within(dialog).getByRole('button', { name: 'Add date' }))
    await user.type(date, '2026-12-25')
    await user.click(within(dialog).getByRole('button', { name: 'Add date' }))
    expect(within(dialog).getAllByRole('button', { name: 'Remove 2026-12-25' })).toHaveLength(1)
  })

  it('turns dependencies off, and shows why turning them back on is refused', async () => {
    const { store, user } = await setup()
    let dialog = await open(user)
    await user.click(within(dialog).getByRole('checkbox', { name: 'Dependencies drive dates' }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(store.getState().data!.sheet.dependenciesEnabled).toBe(false)
    expect(store.getState().data!.dependencies).toHaveLength(2)

    expect(store.getState().setCell('r-found', COL.start, '=TODAY()')).toEqual({ ok: true })
    dialog = await open(user)
    await user.click(within(dialog).getByRole('checkbox', { name: 'Dependencies drive dates' }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Remove the formula in Start (row 4) first')
    expect(store.getState().data!.sheet.dependenciesEnabled).toBe(false)
  })

  it('a refused dependencies change does not apply the calendar edits either', async () => {
    const { store, user } = await setup()
    store.getState().setDependenciesEnabled(false)
    store.getState().setCell('r-found', COL.duration, '=1+1')
    const dialog = await open(user)
    await user.click(within(dialog).getByRole('checkbox', { name: 'Saturday' }))
    await user.click(within(dialog).getByRole('checkbox', { name: 'Dependencies drive dates' }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(within(dialog).getByRole('alert')).toBeInTheDocument()
    expect(store.getState().data!.sheet.calendar.workingWeekdays).toEqual([1, 2, 3, 4, 5])
  })
})

async function vi_waitSaved(store: Awaited<ReturnType<typeof makeTestStore>>['store']) {
  for (let i = 0; i < 50 && store.getState().saveStatus !== 'saved'; i++) await new Promise((r) => setTimeout(r, 0))
}
