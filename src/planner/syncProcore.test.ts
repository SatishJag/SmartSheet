import { describe, expect, it } from 'vitest'
import type { StoreApi } from 'zustand/vanilla'
import type { Column } from '../model/validate'
import type { SheetData } from '../store/persistence'
import type { SheetState } from '../store/sheetStore'
import { makeRow, makeSheetData, makeTestStore } from '../test/fixtures'
import type { CommittedResponse } from './types'
import { AWARDED_COLUMN_TITLE, COMMITTED_COLUMN_TITLE, applySync, canSyncProcore, collectSync, syncResultText, type SyncSummary } from './syncProcore'

const C = { task: 'c-task', project: 'c-project', cost: 'c-cost', site: 'c-site', basis: 'c-basis' }
const BASE_COLUMNS: Column[] = [
  { id: C.task, title: 'Task', type: 'TEXT_NUMBER' },
  { id: C.project, title: 'Project', type: 'PICKLIST', options: ['BKK-03 — Bangkok 3', 'VIL-01 — Sample villa'] },
  { id: C.cost, title: 'Cost code', type: 'PICKLIST', options: ['CHL — Chiller', 'GEN — Generator'] },
  { id: C.site, title: 'Delivery site', type: 'PICKLIST', options: ['BKK-03 — Bangkok 3'] },
  { id: C.basis, title: 'Basis', type: 'TEXT_NUMBER' },
]

function sheet(rows: SheetData['rows'], columns: Column[] = BASE_COLUMNS): SheetData {
  const d = makeSheetData({ columns, rows, dependencies: [] })
  d.sheet.dependenciesEnabled = false
  return d
}

const tagged = (project: string, cost: string) => ({ [C.project]: project, [C.cost]: cost })

/** One item, flat: every row carries the project and cost code. */
const FLAT = sheet([
  makeRow('a', 'a0', { [C.task]: 'Design', ...tagged('BKK-03 — Bangkok 3', 'CHL — Chiller') }),
  makeRow('b', 'a1', { [C.task]: 'Order', ...tagged('BKK-03 — Bangkok 3', 'CHL — Chiller') }),
  makeRow('c', 'a2', { [C.task]: 'Deliver', ...tagged('BKK-03 — Bangkok 3', 'CHL — Chiller') }),
  makeRow('d', 'a3', { [C.task]: 'Untagged', [C.project]: 'BKK-03 — Bangkok 3' }),
])

/** Several items: summary rows carry the tags, children do not. */
const MULTI = sheet([
  makeRow('s1', 'a0', { [C.task]: 'Chiller 1', ...tagged('BKK-03 — Bangkok 3', 'CHL — Chiller') }),
  makeRow('s1a', 'a0', { [C.task]: 'Order' }, 's1'),
  makeRow('s2', 'a1', { [C.task]: 'Chiller 2', ...tagged('BKK-03 — Bangkok 3', 'CHL — Chiller') }),
  makeRow('s2a', 'a0', { [C.task]: 'Order' }, 's2'),
  makeRow('s3', 'a2', { [C.task]: 'Generator', ...tagged('BKK-03 — Bangkok 3', 'GEN — Generator') }),
  makeRow('s3a', 'a0', { [C.task]: 'Order' }, 's3'),
  makeRow('s4', 'a3', { [C.task]: 'Villa chiller', ...tagged('VIL-01 — Sample villa', 'CHL — Chiller') }),
  makeRow('s4a', 'a0', { [C.task]: 'Order' }, 's4'),
])

const titles = (store: StoreApi<SheetState>) => store.getState().data!.columns.map((c) => c.title)
const colId = (store: StoreApi<SheetState>, title: string) => store.getState().data!.columns.find((c) => c.title === title)!.id
const cell = (store: StoreApi<SheetState>, rowId: string, title: string) => store.getState().data!.rows.find((r) => r.id === rowId)!.cells[colId(store, title)]

const OK_RESPONSE: CommittedResponse = {
  ok: true,
  projects: [
    {
      code: 'BKK-03',
      status: 'ok',
      costCodes: [
        { code: 'CHL', committed: 1250000.5, awarded: true, known: true },
        { code: 'GEN', committed: 0, awarded: false, known: false },
      ],
    },
    { code: 'VIL-01', status: 'not-in-procore' },
  ],
}

describe('canSyncProcore', () => {
  it('needs a Cost code column and a Project (or Procore project) column', () => {
    expect(canSyncProcore(sheet([]))).toBe(true)
    expect(canSyncProcore(sheet([], BASE_COLUMNS.map((c) => (c.id === C.project ? { ...c, title: 'Procore project' } : c))))).toBe(true)
    expect(canSyncProcore(sheet([], BASE_COLUMNS.filter((c) => c.id !== C.cost)))).toBe(false)
    expect(canSyncProcore(sheet([], BASE_COLUMNS.filter((c) => c.id !== C.project)))).toBe(false)
  })
})

describe('collectSync', () => {
  it('groups rows by project and cost code', () => {
    expect(collectSync(FLAT)).toEqual({
      request: { projects: [{ code: 'BKK-03', costCodes: ['CHL'] }] },
      groups: [{ project: 'BKK-03', costCode: 'CHL', rowIds: ['a', 'b', 'c'], items: 1 }],
    })
  })

  it('counts summary rows as items', () => {
    expect(collectSync(MULTI)).toEqual({
      request: {
        projects: [
          { code: 'BKK-03', costCodes: ['CHL', 'GEN'] },
          { code: 'VIL-01', costCodes: ['CHL'] },
        ],
      },
      groups: [
        { project: 'BKK-03', costCode: 'CHL', rowIds: ['s1', 's2'], items: 2 },
        { project: 'BKK-03', costCode: 'GEN', rowIds: ['s3'], items: 1 },
        { project: 'VIL-01', costCode: 'CHL', rowIds: ['s4'], items: 1 },
      ],
    })
  })

  it('normalises cost codes from cells', () => {
    const data = sheet([makeRow('a', 'a0', tagged('BKK-03 — Bangkok 3', ' chl '))])
    expect(collectSync(data).groups[0].costCode).toBe('CHL')
  })

  it('reads a bare project code', () => {
    const data = sheet([makeRow('a', 'a0', tagged(' BKK-03 ', 'CHL — Chiller'))])
    expect(collectSync(data).request).toEqual({ projects: [{ code: 'BKK-03', costCodes: ['CHL'] }] })
  })

  it('reads the older Procore project column', () => {
    const columns = BASE_COLUMNS.map((c) => (c.id === C.project ? { ...c, title: 'Procore project' } : c))
    expect(collectSync(sheet(FLAT.rows, columns)).groups).toHaveLength(1)
  })
})

describe('applySync', () => {
  it('adds the two columns after Delivery site and writes values for synced projects only', async () => {
    const { store } = await makeTestStore(MULTI)
    const summary = applySync(store, collectSync(MULTI), OK_RESPONSE)
    expect(titles(store)).toEqual(['Task', 'Project', 'Cost code', 'Delivery site', COMMITTED_COLUMN_TITLE, AWARDED_COLUMN_TITLE, 'Basis'])
    expect(store.getState().data!.columns.find((c) => c.title === AWARDED_COLUMN_TITLE)).toMatchObject({ type: 'PICKLIST', options: ['Yes', 'No'] })
    expect([cell(store, 's1', COMMITTED_COLUMN_TITLE), cell(store, 's1', AWARDED_COLUMN_TITLE)]).toEqual([1250000.5, 'Yes'])
    expect([cell(store, 's2', COMMITTED_COLUMN_TITLE), cell(store, 's2', AWARDED_COLUMN_TITLE)]).toEqual([1250000.5, 'Yes'])
    expect([cell(store, 's3', COMMITTED_COLUMN_TITLE), cell(store, 's3', AWARDED_COLUMN_TITLE)]).toEqual([0, 'No'])
    expect(cell(store, 's4', COMMITTED_COLUMN_TITLE)).toBeUndefined()
    expect(cell(store, 's1a', COMMITTED_COLUMN_TITLE)).toBeUndefined()
    expect(summary).toEqual({
      items: 3,
      notFound: [{ project: 'BKK-03', costCode: 'GEN' }],
      notInProcore: ['VIL-01'],
      projectsNotFound: [],
      shared: [{ project: 'BKK-03', costCode: 'CHL', items: 2 }],
    } satisfies SyncSummary)
  })

  it('adds the columns before Basis when there is no Delivery site column', async () => {
    const data = sheet(FLAT.rows, BASE_COLUMNS.filter((c) => c.id !== C.site))
    const { store } = await makeTestStore(data)
    applySync(store, collectSync(data), OK_RESPONSE)
    expect(titles(store)).toEqual(['Task', 'Project', 'Cost code', COMMITTED_COLUMN_TITLE, AWARDED_COLUMN_TITLE, 'Basis'])
    expect(cell(store, 'c', AWARDED_COLUMN_TITLE)).toBe('Yes')
  })

  it('reuses columns that already exist', async () => {
    const columns: Column[] = [...BASE_COLUMNS, { id: 'c-awarded', title: 'awarded', type: 'TEXT_NUMBER' }]
    const data = sheet(FLAT.rows, columns)
    const { store } = await makeTestStore(data)
    applySync(store, collectSync(data), OK_RESPONSE)
    expect(titles(store)).toEqual(['Task', 'Project', 'Cost code', 'Delivery site', COMMITTED_COLUMN_TITLE, 'Basis', 'awarded'])
    expect(store.getState().data!.rows.find((r) => r.id === 'a')!.cells['c-awarded']).toBe('Yes')
    // A second sync adds nothing.
    applySync(store, collectSync(store.getState().data!), OK_RESPONSE)
    expect(titles(store)).toHaveLength(7)
  })

  it('writes nothing when no project was synced', async () => {
    const { store } = await makeTestStore(FLAT)
    const summary = applySync(store, collectSync(FLAT), { ok: true, projects: [{ code: 'BKK-03', status: 'not-found' }] })
    expect(titles(store)).toEqual(['Task', 'Project', 'Cost code', 'Delivery site', 'Basis'])
    expect(summary).toEqual({ items: 0, notFound: [], notInProcore: [], projectsNotFound: ['BKK-03'], shared: [] })
  })
})

describe('syncResultText', () => {
  const at = new Date(2026, 10, 22, 14, 5)
  it('says what was updated and what was not', () => {
    expect(
      syncResultText(
        {
          items: 6,
          notFound: [{ project: 'BKK-03', costCode: 'ELE' }],
          notInProcore: ['VIL-01'],
          projectsNotFound: ['BKK-02'],
          shared: [{ project: 'BKK-03', costCode: 'CHL', items: 2 }],
        },
        at,
      ),
    ).toBe(
      'Last synced 14:05 · 6 items updated · 1 cost code not found in Procore (ELE on BKK-03) · VIL-01 is not in Procore · BKK-02 was not found in Procore · CHL on BKK-03 is shared by 2 items; both show the cost code total',
    )
  })

  it('says "all" when more than two items share a cost code', () => {
    expect(syncResultText({ items: 3, notFound: [], notInProcore: [], projectsNotFound: [], shared: [{ project: 'BKK-03', costCode: 'CHL', items: 3 }] }, at)).toBe(
      'Last synced 14:05 · 3 items updated · CHL on BKK-03 is shared by 3 items; all show the cost code total',
    )
  })

  it('uses singular forms and lists several', () => {
    expect(
      syncResultText(
        {
          items: 1,
          notFound: [
            { project: 'BKK-03', costCode: 'ELE' },
            { project: 'BKK-03', costCode: 'HVS' },
          ],
          notInProcore: ['VIL-01', 'TWR-01'],
          projectsNotFound: [],
          shared: [],
        },
        new Date(2026, 10, 22, 9, 7),
      ),
    ).toBe('Last synced 09:07 · 1 item updated · 2 cost codes not found in Procore (ELE on BKK-03, HVS on BKK-03) · VIL-01 and TWR-01 are not in Procore')
  })
})
