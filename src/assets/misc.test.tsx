import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { niceTicks } from './chartMath'
import { emptyFilter } from './definition'
import { FilterEditor, opsFor, type FilterColumn } from './FilterEditor'
import { pushRecent, readRecent, RECENT_LIMIT } from './recent'
import type { ReportFilter } from './types'

describe('niceTicks for whole numbers', () => {
  it('never puts a fraction on a count axis', () => {
    expect(niceTicks(0, 2, 4, true).values).toEqual([0, 1, 2])
    expect(niceTicks(0, 2).values).toContain(0.5)
  })
})

describe('recent assets', () => {
  beforeEach(() => localStorage.clear())

  it('keeps the latest first, once each, and at most 12', () => {
    pushRecent('u1', 'sheet', 'a', 1)
    pushRecent('u1', 'report', 'b', 2)
    pushRecent('u1', 'sheet', 'a', 3)
    expect(readRecent('u1').map((r) => `${r.type}:${r.id}`)).toEqual(['sheet:a', 'report:b'])
    for (let i = 0; i < 20; i++) pushRecent('u1', 'dashboard', `d${i}`, 10 + i)
    expect(readRecent('u1')).toHaveLength(RECENT_LIMIT)
    expect(readRecent('u1')[0].id).toBe('d19')
  })

  it("is per user and survives broken storage", () => {
    pushRecent('u1', 'sheet', 'a')
    expect(readRecent('u2')).toEqual([])
    localStorage.setItem('smartsheet-recent:u1', '{"not":"a list"}')
    expect(readRecent('u1')).toEqual([])
    localStorage.setItem('smartsheet-recent:u1', 'garbage')
    expect(readRecent('u1')).toEqual([])
  })
})

describe('FilterEditor', () => {
  const columns: FilterColumn[] = [
    { key: 'c:task', title: 'Task', type: 'TEXT_NUMBER' },
    { key: 'c:status', title: 'Status', type: 'PICKLIST', options: ['Open', 'Done'] },
    { key: 'c:due', title: 'Due', type: 'DATE' },
    { key: 'c:urgent', title: 'Urgent', type: 'CHECKBOX' },
  ]

  function Harness({ initial = emptyFilter() }: { initial?: ReportFilter }) {
    const [value, setValue] = useState(initial)
    return (
      <>
        <FilterEditor columns={columns} value={value} onChange={setValue} />
        <output data-testid="json">{JSON.stringify(value)}</output>
      </>
    )
  }
  const json = () => JSON.parse(screen.getByTestId('json').textContent!) as ReportFilter

  it('adds conditions with the right controls for each column type', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Add filter' }))
    expect(json().conditions).toEqual([{ column: 'c:task', op: 'is', value: '', value2: '' }])

    await user.selectOptions(screen.getByLabelText('Filter 1 column'), 'Status')
    expect(within(screen.getByLabelText('Filter 1 value')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Choose…', 'Open', 'Done'])

    await user.selectOptions(screen.getByLabelText('Filter 1 column'), 'Due')
    await user.selectOptions(screen.getByLabelText('Filter 1 condition'), 'is between')
    await user.type(screen.getByLabelText('Filter 1 value'), 'today')
    await user.type(screen.getByLabelText('Filter 1 second value'), 'today+7')
    expect(json().conditions[0]).toEqual({ column: 'c:due', op: 'between', value: 'today', value2: 'today+7' })
    expect(within(screen.getByLabelText('Filter 1 condition')).getByRole('option', { name: 'is before' })).toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('Filter 1 column'), 'Urgent')
    expect(json().conditions[0]).toMatchObject({ op: 'is', value: 'true' })
    expect(within(screen.getByLabelText('Filter 1 condition')).getAllByRole('option')).toHaveLength(1)
  })

  it('hides the value for blank tests, offers all / any for several conditions, and removes a condition', async () => {
    const user = userEvent.setup()
    render(<Harness initial={{ match: 'all', conditions: [{ column: 'c:task', op: 'blank', value: '', value2: '' }, { column: 'c:task', op: 'contains', value: 'x', value2: '' }] }} />)
    expect(screen.queryByLabelText('Filter 1 value')).toBeNull()
    expect(screen.getByLabelText('Filter 2 value')).toHaveValue('x')
    await user.click(screen.getByRole('button', { name: 'any condition' }))
    expect(json().match).toBe('any')
    await user.click(screen.getByRole('button', { name: 'Remove filter 1' }))
    expect(json().conditions).toHaveLength(1)
    expect(screen.queryByRole('group', { name: /how the conditions combine/ })).toBeNull()
  })

  it('keeps a condition whose column is gone visible instead of dropping it', () => {
    render(<Harness initial={{ match: 'all', conditions: [{ column: 'c:gone', op: 'is', value: 'x', value2: '' }] }} />)
    expect(within(screen.getByLabelText('Filter 1 column')).getByRole('option', { name: 'gone (missing)' })).toBeInTheDocument()
  })

  it('offers date words for dates only', () => {
    expect(opsFor('DATE')).toContain('lastDays')
    expect(opsFor('TEXT_NUMBER')).not.toContain('lastDays')
    expect(opsFor('CHECKBOX')).toEqual(['is'])
  })
})
