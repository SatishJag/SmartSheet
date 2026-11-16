import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { createResourceStore } from './resourceStore'
import { ResourceStoreProvider } from './ResourceStoreContext'
import { ResourceList } from './ResourceList'
import { validateResource } from './ResourceDialog'
import { memory, person } from './testkit'

async function mount(p = memory({ resources: [person('ada', { name: 'Ada Okafor', department: 'Electrical', skills: ['Wiring'], costRate: 62 })] })) {
  const store = createResourceStore(p)
  render(
    <ResourceStoreProvider store={store}>
      <ResourceList />
    </ResourceStoreProvider>,
  )
  await store.getState().loadAll()
  return { store, p }
}

describe('validateResource', () => {
  const base = { id: 'r', name: 'Ada', kind: 'person' as const, department: '', skills: '', costRate: '', hours: ['0', '8', '8', '8', '8', '8', '0'], timeOff: [] }

  it('accepts a minimal resource and trims and dedupes', () => {
    const v = validateResource({ ...base, name: '  Ada  ', department: ' Electrical ', skills: 'Wiring, wiring ,, Testing', costRate: '55.5' })
    expect(v).toEqual({
      ok: true,
      resource: { id: 'r', name: 'Ada', kind: 'person', department: 'Electrical', skills: ['Wiring', 'wiring', 'Testing'], costRate: 55.5, hoursByWeekday: [0, 8, 8, 8, 8, 8, 0], timeOff: [] },
    })
  })

  it('rejects what the database would', () => {
    const err = (over: Partial<Parameters<typeof validateResource>[0]>) => {
      const v = validateResource({ ...base, ...over })
      return v.ok ? null : v.error
    }
    expect(err({ name: '  ' })).toBe('Enter a name')
    expect(err({ name: 'x'.repeat(101) })).toMatch(/100 characters/)
    expect(err({ costRate: '-1' })).toMatch(/cost rate/)
    expect(err({ costRate: 'abc' })).toMatch(/cost rate/)
    expect(err({ hours: ['0', '25', '8', '8', '8', '8', '0'] })).toMatch(/0 to 24/)
    expect(err({ hours: ['0', 'x', '8', '8', '8', '8', '0'] })).toMatch(/0 to 24/)
    expect(err({ skills: Array.from({ length: 31 }, (_, i) => `s${i}`).join(',') })).toMatch(/30 skills/)
    expect(err({ skills: 'x'.repeat(41) })).toMatch(/40 characters/)
    expect(err({ timeOff: [{ start: '', end: '2026-12-01', hours: '0' }] })).toMatch(/start and an end/)
    expect(err({ timeOff: [{ start: '2026-12-02', end: '2026-12-01', hours: '0' }] })).toMatch(/cannot end before/)
    expect(err({ timeOff: [{ start: '2026-12-01', end: '2026-12-01', hours: '30' }] })).toMatch(/0 to 24/)
    expect(err({ timeOff: [{ start: '2000-01-01', end: '2020-01-01', hours: '0' }] })).toMatch(/10 years/)
  })

  it('blank hours count as 0 and time off keeps its note', () => {
    const v = validateResource({ ...base, hours: ['', '8', '', '', '', '', ''], timeOff: [{ start: '2026-12-01', end: '2026-12-02', hours: '', note: ' Leave ' }] })
    expect(v).toMatchObject({ ok: true, resource: { hoursByWeekday: [0, 8, 0, 0, 0, 0, 0], timeOff: [{ start: '2026-12-01', end: '2026-12-02', hours: 0, note: 'Leave' }] } })
  })
})

describe('ResourceList', () => {
  it('lists resources with capacity, rate, department and skills', async () => {
    await mount()
    const list = await screen.findByRole('list', { name: 'Resource list' })
    const card = within(list).getByRole('heading', { name: 'Ada Okafor' }).closest('li')!
    expect(within(card).getByText('Person')).toBeInTheDocument()
    expect(within(card).getByText('Electrical')).toBeInTheDocument()
    expect(within(card).getByText('Wiring')).toBeInTheDocument()
    expect(within(card).getByText('40 h/week')).toBeInTheDocument()
    expect(within(card).getByText('62/h')).toBeInTheDocument()
  })

  it('adds a resource with a capacity and time off', async () => {
    const user = userEvent.setup()
    const { store, p } = await mount()
    await user.click(screen.getByRole('button', { name: 'Add resource' }))
    const dialog = screen.getByRole('dialog', { name: 'Add resource' })
    await user.type(within(dialog).getByLabelText('Name'), 'Tower crane')
    await user.click(within(dialog).getByRole('button', { name: 'Equipment' }))
    await user.type(within(dialog).getByLabelText('Department'), 'Plant')
    await user.type(within(dialog).getByLabelText('Cost rate per hour'), '120')
    await user.type(within(dialog).getByLabelText('Skills'), 'Lifting, Hoisting')
    const sat = within(dialog).getByLabelText('Sat hours')
    await user.clear(sat)
    await user.type(sat, '5')
    expect(within(dialog).getByText('45 hours a week')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Add time off' }))
    fireEvent.change(within(dialog).getByLabelText('From'), { target: { value: '2026-12-21' } })
    fireEvent.change(within(dialog).getByLabelText('To'), { target: { value: '2026-12-23' } })
    await user.type(within(dialog).getByLabelText('Note'), 'Inspection')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    const saved = store.getState().resources.find((r) => r.name === 'Tower crane')!
    expect(saved).toMatchObject({
      kind: 'equipment',
      department: 'Plant',
      costRate: 120,
      skills: ['Lifting', 'Hoisting'],
      hoursByWeekday: [0, 8, 8, 8, 8, 8, 5],
      timeOff: [{ start: '2026-12-21', end: '2026-12-23', hours: 0, note: 'Inspection' }],
    })
    expect(p.saveResource).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('heading', { name: 'Tower crane' })).toBeInTheDocument()
  })

  it('shows a validation error and keeps the dialog open', async () => {
    const user = userEvent.setup()
    const { p } = await mount()
    await user.click(screen.getByRole('button', { name: 'Add resource' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a name')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(p.saveResource).not.toHaveBeenCalled()
  })

  it('shows the database error when saving fails', async () => {
    const user = userEvent.setup()
    const p = memory({ resources: [] })
    p.saveResource = async () => {
      throw new Error('permission denied')
    }
    await mount(p)
    await user.click(screen.getAllByRole('button', { name: /Add (your first )?resource/ })[0])
    await user.type(screen.getByLabelText('Name'), 'Zed')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('permission denied')
  })

  it('edits an existing resource in place', async () => {
    const user = userEvent.setup()
    const { store } = await mount()
    await user.click(await screen.findByRole('button', { name: /Edit\s*Ada Okafor/ }))
    const dialog = screen.getByRole('dialog', { name: 'Edit resource' })
    const name = within(dialog).getByLabelText('Name')
    expect(name).toHaveValue('Ada Okafor')
    expect(within(dialog).getByLabelText('Skills')).toHaveValue('Wiring')
    await user.clear(name)
    await user.type(name, 'Ada L. Okafor')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(store.getState().resources).toHaveLength(1)
    expect(store.getState().resources[0]).toMatchObject({ id: 'ada', name: 'Ada L. Okafor' })
  })

  it('removes a resource after confirming, with its assignments', async () => {
    const user = userEvent.setup()
    const p = memory({
      resources: [person('ada', { name: 'Ada Okafor' })],
      assignments: [{ id: 'a', sheetId: 's', rowId: 't', resourceId: 'ada', allocation: { kind: 'percent', value: 50 }, startDate: null, endDate: null }],
    })
    const { store } = await mount(p)
    await user.click(await screen.findByRole('button', { name: 'Remove Ada Okafor' }))
    const confirm = screen.getByRole('alertdialog')
    expect(within(confirm).getByText(/Their 1 assignment/)).toBeInTheDocument()
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    expect(store.getState().resources).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Remove Ada Okafor' }))
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }))
    expect(store.getState().resources).toHaveLength(0)
    expect(store.getState().assignments).toHaveLength(0)
  })

  it('closes the dialog with Escape and traps Tab inside it', async () => {
    const user = userEvent.setup()
    await mount()
    await user.click(await screen.findByRole('button', { name: 'Add resource' }))
    const dialog = screen.getByRole('dialog')
    for (let i = 0; i < 40; i++) {
      await user.tab()
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('has an empty state and filters by search text', async () => {
    const user = userEvent.setup()
    await mount(memory({ resources: [person('a', { name: 'Ada' }), person('b', { name: 'Ben', skills: ['Welding'] })] }))
    expect(await screen.findAllByRole('heading', { level: 3 })).toHaveLength(2)
    await user.type(screen.getByLabelText('Search resources'), 'weld')
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(1)
    expect(screen.getByRole('heading', { name: 'Ben' })).toBeInTheDocument()
  })

  it('invites you to add the first resource', async () => {
    await mount(memory({}))
    expect(await screen.findByText('No resources yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add your first resource' })).toBeInTheDocument()
  })
})
