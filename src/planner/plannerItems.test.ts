import { describe, expect, it } from 'vitest'
import {
  addCardItem,
  effectiveDate,
  firstProblem,
  isPristine,
  jobFromForm,
  MAX_ITEMS,
  newItem,
  OTHER,
  removeCardItem,
  removeItem,
  setCostCode,
  setDeliverySite,
  syncCostCodes,
  syncDeliverySites,
  validateItems,
  type FormValues,
  type ItemForm,
} from './plannerItems'

const item = (patch: Partial<ItemForm> = {}): ItemForm => ({ ...newItem('Power transformer'), name: '400 MVA', date: '2027-09-01', ...patch })
const form = (items: ItemForm[], patch: Partial<FormValues> = {}): FormValues => ({
  scheduleType: 'lle-procurement',
  items,
  sameDate: true,
  sharedDate: '',
  notes: '',
  ...patch,
})

describe('effectiveDate', () => {
  it('is the item\'s own date; empty falls back to the shared date only with several items and "same date" on', () => {
    const a = item({ date: '' })
    const b = item({ date: '2027-10-01' })
    expect(effectiveDate(a, form([a], { sharedDate: '2028-01-01' }))).toBe('')
    expect(effectiveDate(a, form([a, b], { sharedDate: '2028-01-01' }))).toBe('2028-01-01')
    expect(effectiveDate(b, form([a, b], { sharedDate: '2028-01-01' }))).toBe('2027-10-01')
    expect(effectiveDate(a, form([a, b], { sharedDate: '2028-01-01', sameDate: false }))).toBe('')
  })
})

describe('validateItems with the schedule type’s words', () => {
  it('names what is being planned in each message, and says equipment by default', () => {
    const empty = item({ choice: OTHER, other: '', name: '', date: '' })
    const f = form([empty], { sameDate: false })
    expect(validateItems(f)[empty.key]).toEqual({
      type: 'Enter the equipment type',
      name: 'Enter the equipment name',
      date: 'Enter the date the equipment must be on site',
    })
    expect(validateItems(f, 'subcontract package')[empty.key]).toEqual({
      type: 'Enter the subcontract package type',
      name: 'Enter the subcontract package name',
      date: 'Enter the date the subcontract package must be on site',
    })
    const long = item({ choice: OTHER, other: 'x'.repeat(101), name: 'y'.repeat(201) })
    const e = validateItems(form([long]), 'material')[long.key]
    expect(e.type).toMatch(/^The material type can be at most/)
    expect(e.name).toMatch(/^The material name can be at most/)
  })
})

describe('validateItems / firstProblem', () => {
  it('a valid single item has no errors', () => {
    const f = form([item()])
    expect(validateItems(f)).toEqual({})
    expect(firstProblem(f, {})).toBeNull()
  })

  it('reports each item\'s own problems, by item', () => {
    const a = item()
    const b = item({ name: ' ', date: '' })
    const c = item({ choice: OTHER, other: '', date: '1969-01-01' })
    const f = form([a, b, c])
    const errors = validateItems(f)
    expect(errors[a.key]).toBeUndefined()
    expect(errors[b.key]).toEqual({ name: 'Enter the equipment name', date: 'Enter a date, or fill in the shared date' })
    expect(errors[c.key]).toEqual({ type: 'Enter the equipment type', date: 'Enter a date between 1970-01-01 and 2100-12-31' })
  })

  it('the shared date satisfies an item without its own date', () => {
    const a = item({ date: '' })
    const b = item({ date: '' })
    expect(validateItems(form([a, b], { sharedDate: '2028-01-01' }))).toEqual({})
    expect(Object.keys(validateItems(form([a, b], { sharedDate: '' })))).toHaveLength(2)
    expect(validateItems(form([a, b], { sameDate: false, sharedDate: '2028-01-01' }))[a.key]?.date).toBe('Enter the date the equipment must be on site')
  })

  it('limits the lengths the server enforces', () => {
    const f = form([item({ name: 'x'.repeat(201), choice: OTHER, other: 'y'.repeat(101) })])
    expect(validateItems(f)[f.items[0].key]).toMatchObject({
      type: 'The equipment type can be at most 100 characters',
      name: 'The equipment name can be at most 200 characters',
    })
  })

  it('firstProblem is the first message, prefixed with the item number when there are several items', () => {
    const one = form([item({ name: '' })])
    expect(firstProblem(one, validateItems(one))).toBe('Enter the equipment name')
    const two = form([item(), item({ name: '' })])
    expect(firstProblem(two, validateItems(two))).toBe('Item 2: Enter the equipment name')
    expect(firstProblem({ ...one, scheduleType: '' }, {})).toBe('Choose a schedule type')
  })
})

describe('jobFromForm', () => {
  it('trims, resolves each item\'s date and carries the shared notes', () => {
    const a = item({ name: ' 400 MVA ', date: '' })
    const b = item({ choice: OTHER, other: ' Gas turbine ', name: 'GT-1', date: '2027-10-01' })
    const job = jobFromForm(form([a, b], { sharedDate: '2028-01-01', notes: ' Be conservative ' }))
    expect(job).toEqual({
      scheduleType: 'lle-procurement',
      notes: 'Be conservative',
      items: [
        { key: a.key, equipmentType: 'Power transformer', equipmentName: '400 MVA', requiredDate: '2028-01-01' },
        { key: b.key, equipmentType: 'Gas turbine', equipmentName: 'GT-1', requiredDate: '2027-10-01' },
      ],
    })
  })

  it('leaves notes out when blank', () => {
    expect(jobFromForm(form([item()], { notes: '  ' }))).not.toHaveProperty('notes')
  })
})

describe('equipment cards', () => {
  it('a card replaces untouched placeholder items and links its item to the card', () => {
    const placeholder = newItem('Power transformer')
    expect(isPristine(placeholder)).toBe(true)
    const one = addCardItem([placeholder], 'Switchgear')
    expect(one).toHaveLength(1)
    expect(one[0]).toMatchObject({ choice: 'Switchgear', fromCard: 'Switchgear' })
    const two = addCardItem(one, 'Chiller')
    expect(two.map((i) => i.choice)).toEqual(['Switchgear', 'Chiller'])
  })

  it('keeps items the user has started', () => {
    const typed = item({ date: '' })
    expect(isPristine(typed)).toBe(false)
    expect(addCardItem([typed], 'Chiller').map((i) => i.choice)).toEqual(['Power transformer', 'Chiller'])
  })

  it('unticking removes that card\'s item; the form never ends up empty', () => {
    const a = addCardItem([newItem('x')], 'Switchgear')
    const b = addCardItem(a, 'Chiller')
    expect(removeCardItem(b, 'Switchgear', 'Power transformer').map((i) => i.choice)).toEqual(['Chiller'])
    const empty = removeCardItem(a, 'Switchgear', 'Power transformer')
    expect(empty).toHaveLength(1)
    expect(empty[0]).toMatchObject({ choice: 'Power transformer', fromCard: null, name: '' })
  })

  it('stops at the maximum', () => {
    let items: ItemForm[] = [newItem('x')]
    for (let i = 0; i < MAX_ITEMS; i++) items = addCardItem(items, `Type ${i}`)
    expect(items).toHaveLength(MAX_ITEMS)
    expect(addCardItem(items, 'One more')).toBe(items)
  })

  it('removeItem drops one item and keeps at least one', () => {
    const a = item()
    const b = item()
    expect(removeItem([a, b], a.key, 'x')).toEqual([b])
    expect(removeItem([a], a.key, 'Chiller')[0]).toMatchObject({ choice: 'Chiller', name: '' })
  })
})

describe('cost codes', () => {
  const codeFor = (t: string) => ({ Chiller: 'CHL', 'Diesel generator': 'GEN' })[t] ?? ''

  it('starts a new item with no code, unedited', () => {
    expect(newItem('Chiller')).toMatchObject({ costCode: '', costCodeEdited: false })
  })

  it('fills an unedited item’s code from its type', () => {
    const [a] = syncCostCodes([newItem('Chiller')], codeFor)
    expect(a.costCode).toBe('CHL')
  })

  it('follows a type change while the code is unedited', () => {
    const items = syncCostCodes([newItem('Chiller')], codeFor)
    const [b] = syncCostCodes([{ ...items[0], choice: 'Diesel generator' }], codeFor)
    expect(b.costCode).toBe('GEN')
  })

  it('clears the code when the new type has none', () => {
    const items = syncCostCodes([newItem('Chiller')], codeFor)
    expect(syncCostCodes([{ ...items[0], choice: 'Crane' }], codeFor)[0].costCode).toBe('')
  })

  it('keeps a hand-picked code when the type changes', () => {
    const edited = setCostCode(newItem('Chiller'), 'GEN')
    expect(syncCostCodes([{ ...edited, choice: 'Chiller' }], codeFor)[0].costCode).toBe('GEN')
  })

  it('keeps a hand-cleared code empty when the type changes', () => {
    const cleared = setCostCode(syncCostCodes([newItem('Chiller')], codeFor)[0], '')
    expect(syncCostCodes([{ ...cleared, choice: 'Diesel generator' }], codeFor)[0].costCode).toBe('')
  })

  it('leaves a typed-in type blank even when the text matches a mapped type', () => {
    const other = { ...newItem(OTHER), other: 'Chiller' }
    expect(syncCostCodes([other], codeFor)[0].costCode).toBe('')
  })

  it('returns the same array when nothing changes', () => {
    const items = syncCostCodes([newItem('Chiller')], codeFor)
    expect(syncCostCodes(items, codeFor)).toBe(items)
  })

  it('does not put the cost code in the job', () => {
    const item = { ...setCostCode(newItem('Chiller'), 'CHL'), name: 'Chiller 1', date: '2027-11-17' }
    const job = jobFromForm({ scheduleType: 'lle-procurement', items: [item], sameDate: false, sharedDate: '', notes: '' })
    expect(job.items[0]).not.toHaveProperty('costCode')
  })
})

describe('delivery sites', () => {
  it('starts a new item with no site, unedited', () => {
    expect(newItem('Chiller')).toMatchObject({ deliverySite: '', deliverySiteEdited: false })
  })

  it('gives unedited items the default site', () => {
    expect(syncDeliverySites([newItem('Chiller')], 'BKK-03')[0].deliverySite).toBe('BKK-03')
  })

  it('follows the default when it changes, including to none', () => {
    const items = syncDeliverySites([newItem('Chiller')], 'BKK-03')
    expect(syncDeliverySites(items, '')[0].deliverySite).toBe('')
  })

  it('keeps a site picked by hand', () => {
    const picked = setDeliverySite(newItem('Chiller'), 'BKK-03')
    expect(syncDeliverySites([picked], '')[0].deliverySite).toBe('BKK-03')
  })

  it('keeps a site cleared by hand', () => {
    const cleared = setDeliverySite(syncDeliverySites([newItem('Chiller')], 'BKK-03')[0], '')
    expect(syncDeliverySites([cleared], 'BKK-03')[0].deliverySite).toBe('')
  })

  it('returns the same array when nothing changes', () => {
    const items = syncDeliverySites([newItem('Chiller')], 'BKK-03')
    expect(syncDeliverySites(items, 'BKK-03')).toBe(items)
  })

  it('does not put the site in the job', () => {
    const item = { ...setDeliverySite(newItem('Chiller'), 'BKK-03'), name: 'Chiller 1', date: '2027-11-17' }
    const job = jobFromForm({ scheduleType: 'lle-procurement', items: [item], sameDate: false, sharedDate: '', notes: '' })
    expect(job.items[0]).not.toHaveProperty('deliverySite')
  })
})

describe('a hand-picked site or cost code counts as touching the item', () => {
  it('is no longer pristine', () => {
    expect(isPristine(setDeliverySite(newItem('Chiller'), 'SIN-01'))).toBe(false)
    expect(isPristine(setDeliverySite(newItem('Chiller'), ''))).toBe(false)
    expect(isPristine(setCostCode(newItem('Chiller'), 'GEN'))).toBe(false)
    expect(isPristine(syncDeliverySites(syncCostCodes([newItem('Chiller')], () => 'CHL'), 'BKK-03')[0])).toBe(true)
  })

  it('is kept when a card is ticked, instead of being replaced', () => {
    const picked = setDeliverySite(newItem('Chiller'), 'SIN-01')
    const items = addCardItem([picked], 'Switchgear')
    expect(items).toHaveLength(2)
    expect(items[0]).toBe(picked)
  })
})
