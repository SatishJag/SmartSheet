import { describe, expect, it } from 'vitest'
import type { Column } from '../model/validate'
import type { RuleDraft } from './db'
import { validateRule } from './validateRule'

const cols: Column[] = [
  { id: 'task', title: 'Task', type: 'TEXT_NUMBER' },
  { id: 'status', title: 'Status', type: 'PICKLIST', options: ['Open', 'Done'] },
  { id: 'due', title: 'Due', type: 'DATE' },
  { id: 'start', title: 'Start', type: 'DATE', role: 'start' },
  { id: 'who', title: 'Owner', type: 'CONTACT_LIST' },
  { id: 'pred', title: 'Predecessors', type: 'PREDECESSOR', role: 'predecessor' },
]
const base: RuleDraft = {
  sheetId: 's',
  name: 'Rule',
  enabled: true,
  trigger: { type: 'cell_becomes', columnId: 'status', value: 'Done' },
  conditions: null,
  action: { type: 'notify', recipients: [{ kind: 'owner' }], frequency: 'immediately', include: 'all', linkToRow: true },
}
const check = (over: Partial<RuleDraft>) => validateRule({ ...base, ...over }, cols, ['other'])

describe('validateRule', () => {
  it('accepts a good rule', () => {
    expect(check({})).toEqual([])
  })

  it('needs a name of at most 100 characters', () => {
    expect(check({ name: '  ' })).toEqual(['Give the rule a name.'])
    expect(check({ name: 'x'.repeat(101) })[0]).toMatch(/at most 100/)
  })

  it('checks each trigger', () => {
    expect(check({ trigger: { type: 'cell_becomes', columnId: 'gone', value: 'x' } })).toEqual(['Choose the column to watch.'])
    expect(check({ trigger: { type: 'cell_becomes', columnId: 'status', value: '' } })).toEqual(['Choose the value the cell must become.'])
    expect(check({ trigger: { type: 'cell_becomes', columnId: 'task', value: false } })).toEqual([])
    expect(check({ trigger: { type: 'date', columnId: 'task', when: 'on', days: 0 } })).toEqual(['Choose a date column.'])
    expect(check({ trigger: { type: 'date', columnId: 'due', when: 'before', days: 0 } })).toEqual(['Days must be between 1 and 365.'])
    expect(check({ trigger: { type: 'date', columnId: 'due', when: 'on', days: 0 } })).toEqual([])
    expect(check({ trigger: { type: 'schedule', frequency: 'weekly', time: '25:00' } })).toEqual(['Choose a time of day.', 'Choose a day of the week.'])
    expect(check({ trigger: { type: 'schedule', frequency: 'monthly', time: '09:00', dayOfMonth: 40 } })).toEqual(['Choose a day of the month (1 to 31).'])
    expect(check({ trigger: { type: 'schedule', frequency: 'daily', time: '09:00' } })).toEqual([])
    expect(check({ trigger: { type: 'row_changed', columnIds: ['gone'] } })).toEqual(['A watched column no longer exists.'])
  })

  it('checks conditions, including nested groups', () => {
    expect(check({ conditions: { op: 'and', items: [{ columnId: 'gone', op: 'is_blank' }] } })).toEqual(['A condition uses a column that no longer exists.'])
    expect(check({ conditions: { op: 'and', items: [{ columnId: 'task', op: 'contains', value: ' ' }] } })).toEqual(['A condition needs a value.'])
    expect(check({ conditions: { op: 'and', items: [{ op: 'or', items: [{ columnId: 'due', op: 'in_next_days', value: 'x' }] }] } })).toEqual(['"Within the next (days)" needs a number of days.'])
    expect(check({ conditions: { op: 'and', items: [{ columnId: 'due', op: 'is_past' }, { op: 'or', items: [{ columnId: 'task', op: 'is_blank' }] }] } })).toEqual([])
  })

  it('checks notify recipients', () => {
    const notify = (recipients: RuleDraft['action'] extends infer A ? (A extends { type: 'notify' } ? A['recipients'] : never) : never) =>
      check({ action: { type: 'notify', recipients, frequency: 'daily', include: 'all', linkToRow: true } })
    expect(notify([])).toEqual(['Choose who to notify.'])
    expect(notify([{ kind: 'email', email: 'nope' }])).toEqual(['"nope" is not a valid e-mail address.'])
    expect(notify([{ kind: 'column', columnId: 'gone' }])).toEqual(['A recipient column no longer exists.'])
    expect(notify([{ kind: 'column', columnId: 'who' }, { kind: 'email', email: 'a@b.co' }])).toEqual([])
    expect(check({ action: { type: 'notify', recipients: [{ kind: 'owner' }], frequency: 'daily', include: 'columns', columnIds: [], linkToRow: true } })).toEqual(['Choose the columns to include, or include all of them.'])
  })

  it('checks update requests, approvals and the other actions', () => {
    const upd = (over: object) => check({ action: { type: 'update_request', recipients: [{ kind: 'email', email: 'a@b.co' }], columnIds: ['task'], message: '', expiresInDays: 7, ...over } as RuleDraft['action'] })
    expect(upd({})).toEqual([])
    expect(upd({ recipients: [{ kind: 'owner' }] })).toEqual(['Add at least one e-mail address or a column that holds addresses.'])
    expect(upd({ columnIds: [] })).toEqual(['Choose at least one column the recipient may update.'])
    expect(upd({ columnIds: ['pred'] })).toEqual(['"Predecessors" cannot be edited through a link.'])
    expect(upd({ expiresInDays: 100 })).toEqual(['The link can last 1 to 90 days.'])

    const appr = (over: object) =>
      check({ action: { type: 'approval', recipients: [{ kind: 'email', email: 'a@b.co' }], statusColumnId: 'status', approvedValue: 'Done', declinedValue: 'Open', showColumnIds: [], expiresInDays: 3, ...over } as RuleDraft['action'] })
    expect(appr({})).toEqual([])
    expect(appr({ statusColumnId: 'gone' })).toEqual(['Choose the column that receives the answer.'])
    expect(appr({ approvedValue: 'open' })).toEqual(['Approve and decline must write different values.', '"open" is not an option of "Status".'])
    expect(appr({ pendingValue: 'Maybe' })).toEqual(['"Maybe" is not an option of "Status".'])

    expect(check({ action: { type: 'move', targetSheetId: 'nope' } })).toEqual(['Choose the sheet to send the row to.'])
    expect(check({ action: { type: 'copy', targetSheetId: 'other' } })).toEqual([])
    expect(check({ action: { type: 'record_date', columnId: 'task' } })).toEqual(['Choose a date column to record the date in.'])
    expect(check({ action: { type: 'record_date', columnId: 'start' } })).toEqual(['Start and End dates are set by the schedule; choose another date column.'])
    expect(check({ action: { type: 'record_date', columnId: 'due' } })).toEqual([])
    expect(check({ action: { type: 'lock', locked: false } })).toEqual([])
  })
})
