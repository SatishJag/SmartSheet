// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { colKey, evaluateReport, resolveWriteBack } from './reportEngine'
import { createSheetHub } from './sheetHub'
import { testBackend } from './testBackend'
import { reportDef } from './testSupport'

const TODAY = '2026-11-16'

function setup() {
  const b = testBackend([
    {
      name: 'Site works',
      columns: [['Task'], ['Status', 'PICKLIST', ['Open', 'Done']], ['Cost'], ['Double']],
      rows: [
        ['Dig trench', 'Open', 1200, '=[Cost] * 2'],
        ['Pour slab', 'Done', 3400, '=[Cost] * 2'],
        [null, null, null, null],
      ],
    },
    { name: 'Fit-out', columns: [['task'], ['Status', 'PICKLIST', ['Open', 'Blocked']]], rows: [['Hang doors', 'Blocked']] },
  ])
  return { ...b, hub: createSheetHub(b.client) }
}

describe('SheetHub', () => {
  it('loads sheets once and offers them as plain source sheets with display values', async () => {
    const { hub, sheetIds } = setup()
    expect(hub.sheet(sheetIds[0])).toBeNull()
    await hub.load(sheetIds)
    expect(hub.loadState(sheetIds[0])).toBe('ready')
    const sheet = hub.sheet(sheetIds[0])!
    expect(sheet.name).toBe('Site works')
    expect(sheet.columns.map((c) => c.title)).toEqual(['Task', 'Status', 'Cost', 'Double'])
    expect(sheet.rowIds).toHaveLength(3)
    const [task, , cost, dbl] = sheet.columns.map((c) => c.id)
    expect(sheet.value(sheet.rowIds[0], task)).toBe('Dig trench')
    expect(sheet.value(sheet.rowIds[1], cost)).toBe(3400)
    expect(sheet.value(sheet.rowIds[0], dbl)).toBe(2400) // a formula shows its result
    expect(sheet.rawText!(sheet.rowIds[0], dbl)).toBe('=[Cost] * 2') // and edits as its source
    expect(sheet.isBlankRow!(sheet.rowIds[2])).toBe(true)
    expect(sheet.isBlankRow!(sheet.rowIds[0])).toBe(false)
  })

  it('reports a sheet that cannot be loaded', async () => {
    const { hub } = setup()
    await hub.load(['00000000-0000-4000-8000-0000000fffff'])
    expect(hub.loadState('00000000-0000-4000-8000-0000000fffff')).toBe('error')
    expect(hub.loadError('00000000-0000-4000-8000-0000000fffff')).toBeTruthy()
    expect(hub.sheet('00000000-0000-4000-8000-0000000fffff')).toBeNull()
  })

  it('writes a report edit through the source sheet: validated, shown at once, saved to the database', async () => {
    const { hub, sheetIds, rowIds, columnIds, table } = setup()
    await hub.load(sheetIds)
    const def = reportDef({ sources: sheetIds, columns: [{ key: colKey('Task'), title: 'Task' }, { key: colKey('Status'), title: 'Status' }] })
    const run = () => {
      const sheets = sheetIds.map((id) => hub.sheet(id)!)
      return { result: evaluateReport(def, sheets, { today: TODAY }), byId: new Map(sheets.map((s) => [s.id, s])) }
    }
    const before = run()
    expect(before.result.rows.map((r) => r.values[colKey('Status')])).toEqual(['Open', 'Done', 'Blocked'])

    const fitRow = before.result.rows.find((r) => r.sheetId === sheetIds[1])!
    const target = resolveWriteBack(before.result, before.byId, fitRow, colKey('Status'))
    expect(target).toEqual({ ok: true, sheetId: sheetIds[1], rowId: rowIds[1][0], colId: columnIds[1][1] })
    if (!target.ok) throw new Error('unreachable')

    // A value the source column does not allow is refused with the sheet's own message.
    const bad = hub.setCell(target.sheetId, target.rowId, target.colId, 'Done')
    expect(bad).toMatchObject({ ok: false, error: expect.stringMatching(/Choose one of: Open, Blocked/) })

    expect(hub.setCell(target.sheetId, target.rowId, target.colId, 'Open')).toEqual({ ok: true })
    expect(run().result.rows.map((r) => r.values[colKey('Status')])).toEqual(['Open', 'Done', 'Open'])

    // Saved: wait for the queue, then read the database itself.
    while (hub.saveStatus() !== 'saved') await new Promise((r) => setTimeout(r, 5))
    const stored = table('rows').find((r) => r.id === rowIds[1][0])!
    expect((stored.cells as Record<string, unknown>)[columnIds[1][1]]).toBe('Open')
  })

  it('a formula cell can be replaced with a plain value from a report', async () => {
    const { hub, sheetIds, rowIds, columnIds } = setup()
    await hub.load(sheetIds)
    expect(hub.setCell(sheetIds[0], rowIds[0][0], columnIds[0][3], '7')).toEqual({ ok: true })
    const sheet = hub.sheet(sheetIds[0])!
    expect(sheet.value(rowIds[0][0], columnIds[0][3])).toBe(7)
  })

  it('refuses an edit of a sheet it has not loaded', () => {
    const { hub } = setup()
    expect(hub.setCell('nope', 'r', 'c', 'x')).toEqual({ ok: false, error: 'That sheet is not loaded' })
  })

  it('tells subscribers when something changes, and reloads fresh data', async () => {
    const { hub, sheetIds, rowIds, columnIds, client } = setup()
    let calls = 0
    const off = hub.subscribe(() => calls++)
    await hub.load([sheetIds[0]])
    expect(calls).toBeGreaterThan(0)
    const v = hub.version()
    // Another client changes the database behind the hub's back.
    await client.from('sheets').update({ name: 'Renamed elsewhere' }).eq('id', sheetIds[0])
    expect(hub.sheet(sheetIds[0])!.name).toBe('Site works')
    await hub.reload()
    expect(hub.sheet(sheetIds[0])!.name).toBe('Renamed elsewhere')
    expect(hub.version()).toBeGreaterThan(v)
    off()
    const seen = calls
    hub.setCell(sheetIds[0], rowIds[0][0], columnIds[0][0], 'x')
    expect(calls).toBe(seen)
  })
})
