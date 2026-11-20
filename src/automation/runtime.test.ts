import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Column } from '../model/validate'
import { COL, fixtureColumns, makeSheetData, makeTestStore } from '../test/fixtures'
import { onNotificationsChanged } from './bus'
import type { AutomationApi } from './db'
import { clearLocks, isRowLocked, LOCKED_MESSAGE } from './locks'
import { createAutomationRuntime } from './runtime'
import type { Action, AutomationRule, Trigger } from './types'

const NOW = Date.UTC(2026, 10, 16, 10, 0, 0)
const DONE_ON = 'c-doneon'
const columns: Column[] = [...fixtureColumns, { id: DONE_ON, title: 'Done on', type: 'DATE' }]

function rule(id: string, trigger: Trigger, action: Action, over: Partial<AutomationRule> = {}): AutomationRule {
  return { id, sheetId: 'sheet-1', name: `Rule ${id}`, enabled: true, trigger, conditions: null, action, createdAt: '2026-11-01T00:00:00Z', ...over }
}
const notifyOwner: Action = { type: 'notify', recipients: [{ kind: 'owner' }], frequency: 'immediately', include: 'columns', columnIds: [COL.status], linkToRow: true }
const becomesDone: Trigger = { type: 'cell_becomes', columnId: COL.status, value: 'Done' }

function fakeApi(rules: AutomationRule[]) {
  const runs: { outcome: string; ruleId: string; detail: Record<string, unknown>; dedupKey: string | null }[] = []
  const notifications: { channel: string; title: string; body: string; rowId: string | null; recipientEmail: string | null }[] = []
  const locks = new Set<string>()
  const api = {
    listRules: vi.fn(async () => rules),
    listLocks: vi.fn(async () => [...locks]),
    createNotifications: vi.fn(async (rows: typeof notifications) => void notifications.push(...rows)),
    insertRun: vi.fn(async (r: (typeof runs)[number]) => {
      runs.push(r)
      return true
    }),
    touchRule: vi.fn(async () => {}),
    lockRow: vi.fn(async (_sheet: string, rowId: string) => void locks.add(rowId)),
    unlockRow: vi.fn(async (rowId: string) => void locks.delete(rowId)),
    copyRow: vi.fn(async () => 'new-row'),
  }
  return { api: api as unknown as AutomationApi, raw: api, runs, notifications }
}

async function setup(rules: AutomationRule[], opts: { sendRequest?: (b: unknown) => Promise<{ ok: true } | { ok: false; error: string }> } = {}) {
  const { store } = await makeTestStore(makeSheetData({ columns }))
  const f = fakeApi(rules)
  const runtime = createAutomationRuntime({
    client: {} as SupabaseClient,
    store,
    api: f.api,
    now: () => NOW,
    tzOffsetMinutes: () => 0,
    log: () => {},
    ...(opts.sendRequest ? { sendRequest: opts.sendRequest as never } : {}),
  })
  runtime.start()
  await runtime.idle()
  return { store, runtime, ...f }
}

afterEach(() => clearLocks('sheet-1'))

describe('automation runtime', () => {
  it('runs a rule for the user own edit: in-app notification with the chosen columns, and a log entry', async () => {
    const heard = vi.fn()
    const off = onNotificationsChanged(heard)
    const { store, runtime, notifications, runs, raw } = await setup([rule('r1', becomesDone, notifyOwner, { name: 'When done' })])
    store.getState().setCell('r-clear', COL.status, 'Done')
    await runtime.idle()
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({ channel: 'app', title: 'When done: Clear site', body: 'Status: Done', rowId: 'r-clear', recipientEmail: null })
    expect(runs).toMatchObject([{ outcome: 'done', ruleId: 'r1' }])
    expect(raw.touchRule).toHaveBeenCalledWith('r1', new Date(NOW))
    expect(heard).toHaveBeenCalled()
    off()
    runtime.stop()
  })

  it('does nothing for edits that do not match, nor for the sheet loading', async () => {
    const { store, runtime, notifications, runs } = await setup([rule('r1', becomesDone, notifyOwner)])
    store.getState().setCell('r-clear', COL.status, 'Not started')
    store.getState().setCell('r-clear', COL.status, 'Not started') // no change
    await runtime.idle()
    expect(notifications).toHaveLength(0)
    expect(runs).toHaveLength(0)
    runtime.stop()
  })

  it('a burst of edits is evaluated together, each row once', async () => {
    const { store, runtime, notifications } = await setup([rule('r1', { type: 'row_changed' }, notifyOwner)])
    store.getState().batch(() => {
      store.getState().setCell('r-clear', COL.status, 'Done')
      store.getState().setCell('r-found', COL.status, 'Done')
      store.getState().setCell('r-clear', COL.task, 'Clear site (renamed)')
    })
    await runtime.idle()
    expect(notifications.map((n) => n.rowId).sort()).toEqual(['r-clear', 'r-found'])
    runtime.stop()
  })

  it('does not even look at the rows while there is no enabled row rule', async () => {
    const { store, runtime, runs } = await setup([rule('r1', { type: 'date', columnId: DONE_ON, when: 'on', days: 0 }, notifyOwner), rule('r2', becomesDone, notifyOwner, { enabled: false })])
    store.getState().setCell('r-clear', COL.status, 'Done')
    await runtime.idle()
    expect(runs).toHaveLength(0)
    runtime.stop()
  })

  it('records a date through the store, and the change it causes does not re-run the same rule (loop protection)', async () => {
    const stamp = rule('stamp', { type: 'row_changed' }, { type: 'record_date', columnId: DONE_ON }) // would loop forever on its own write
    const { store, runtime, runs } = await setup([stamp])
    store.getState().setCell('r-clear', COL.task, 'Renamed')
    await runtime.idle()
    await runtime.idle()
    const row = store.getState().data!.rows.find((r) => r.id === 'r-clear')!
    expect(row.cells[DONE_ON]).toBe('2026-11-16')
    expect(runs.filter((r) => r.outcome === 'done')).toHaveLength(1)
    expect(runs.filter((r) => r.outcome === 'skipped')).toMatchObject([{ detail: { reason: 'loop' } }])
    runtime.stop()
  })

  it('a rule can start another rule once, and the chain stops', async () => {
    const a = rule('A', becomesDone, { type: 'record_date', columnId: DONE_ON })
    const b = rule('B', { type: 'row_changed', columnIds: [DONE_ON] }, notifyOwner)
    const { store, runtime, runs, notifications } = await setup([a, b])
    store.getState().setCell('r-clear', COL.status, 'Done')
    await runtime.idle()
    await runtime.idle()
    expect(runs.filter((r) => r.outcome === 'done').map((r) => r.ruleId)).toEqual(['A', 'B'])
    expect(notifications).toHaveLength(1)
    runtime.stop()
  })

  it('a lock action locks the row in the store: edits are refused with a reason until it is unlocked', async () => {
    const lock = rule('lock', becomesDone, { type: 'lock', locked: true })
    const { store, runtime, raw } = await setup([lock])
    store.getState().setCell('r-clear', COL.status, 'Done')
    await runtime.idle()
    expect(raw.lockRow).toHaveBeenCalledWith('sheet-1', 'r-clear', 'lock')
    expect(isRowLocked('sheet-1', 'r-clear')).toBe(true)
    const refused = store.getState().setCell('r-clear', COL.task, 'Try to rename')
    expect(refused).toEqual({ ok: false, error: LOCKED_MESSAGE })
    expect(store.getState().errors).toMatchObject([{ rowId: 'r-clear', colId: COL.task, message: LOCKED_MESSAGE }])
    store.getState().deleteRow('r-clear')
    expect(store.getState().data!.rows.some((r) => r.id === 'r-clear')).toBe(true)
    expect(store.getState().notices).toContain(LOCKED_MESSAGE)
    // other rows are fine
    expect(store.getState().setCell('r-found', COL.task, 'Fine')).toEqual({ ok: true })
    runtime.stop()
    expect(isRowLocked('sheet-1', 'r-clear')).toBe(false) // registry is cleared when the sheet closes
  })

  it('loads existing locks when the sheet opens', async () => {
    const { store } = await makeTestStore(makeSheetData({ columns }))
    const f = fakeApi([])
    f.raw.listLocks.mockResolvedValue(['r-found'])
    const runtime = createAutomationRuntime({ client: {} as SupabaseClient, store, api: f.api, now: () => NOW, log: () => {} })
    runtime.start()
    await runtime.idle()
    expect(store.getState().setCell('r-found', COL.task, 'x')).toMatchObject({ ok: false })
    runtime.stop()
  })

  it('e-mail recipients become outbox rows; the contact column is read from the edited row', async () => {
    const owner = fixtureColumns // reuse: put the address in the Task column (text) for the test
    void owner
    const r = rule('mail', becomesDone, { type: 'notify', recipients: [{ kind: 'column', columnId: COL.task }], frequency: 'daily', include: 'none', linkToRow: true })
    const { store, runtime, notifications } = await setup([r])
    store.getState().setCell('r-clear', COL.task, 'ann@example.com')
    store.getState().setCell('r-clear', COL.status, 'Done')
    await runtime.idle()
    expect(notifications).toMatchObject([{ channel: 'email', recipientEmail: 'ann@example.com' }])
    runtime.stop()
  })

  it('update requests go through the server call; its refusal is logged as an error run', async () => {
    const sendRequest = vi.fn(async () => ({ ok: false as const, error: 'Update requests and approvals need the server' }))
    const r = rule('upd', becomesDone, { type: 'update_request', recipients: [{ kind: 'email', email: 'p@q.co' }], columnIds: [COL.percent], message: 'Please update', expiresInDays: 7 })
    const { store, runtime, runs } = await setup([r], { sendRequest })
    store.getState().setCell('r-clear', COL.status, 'Done')
    await runtime.idle()
    expect(sendRequest).toHaveBeenCalledWith(expect.objectContaining({ kind: 'update', sheetId: 'sheet-1', rowId: 'r-clear', emails: ['p@q.co'], columnIds: [COL.percent], expiresInDays: 7 }))
    expect(runs).toMatchObject([{ outcome: 'error', detail: { steps: [{ error: expect.stringContaining('need the server') }] } }])
    runtime.stop()
  })

  it('copies and moves rows to another sheet (a move removes the original here)', async () => {
    const move = rule('mv', becomesDone, { type: 'move', targetSheetId: 'sheet-2' })
    const { store, runtime, raw } = await setup([move])
    store.getState().setCell('r-found', COL.status, 'Done')
    await runtime.idle()
    expect(raw.copyRow).toHaveBeenCalledWith('r-found', 'sheet-2')
    expect(store.getState().data!.rows.some((r) => r.id === 'r-found')).toBe(false)
    runtime.stop()
  })

  it('a failure to load rules (migration not applied) leaves editing untouched', async () => {
    const { store } = await makeTestStore(makeSheetData({ columns }))
    const f = fakeApi([])
    f.raw.listRules.mockRejectedValue(new Error('relation "automation_rules" does not exist'))
    const log = vi.fn()
    const runtime = createAutomationRuntime({ client: {} as SupabaseClient, store, api: f.api, now: () => NOW, log })
    runtime.start()
    await runtime.idle()
    expect(store.getState().setCell('r-clear', COL.task, 'still works')).toEqual({ ok: true })
    await runtime.idle()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('could not load rules'), expect.any(Error))
    runtime.stop()
  })

  it('stops watching after stop()', async () => {
    const { store, runtime, runs } = await setup([rule('r1', becomesDone, notifyOwner)])
    runtime.stop()
    store.getState().setCell('r-clear', COL.status, 'Done')
    await new Promise((r) => setTimeout(r, 10))
    expect(runs).toHaveLength(0)
  })
})
