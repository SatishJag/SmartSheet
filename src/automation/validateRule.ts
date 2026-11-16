/** Checks a rule as the builder has it, before it is saved. Pure: returns plain sentences for the form. */
import type { Column } from '../model/validate'
import { opNeedsValue } from './conditions'
import type { RuleDraft } from './db'
import { isGroup, type Condition, type ConditionGroup, type Recipient } from './types'
import { isEmail, isBlank } from './values'
import { parseTime } from './time'

export const MAX_RULE_NAME = 100

/** Column types an update request may offer (see server/automation/respond.ts). */
export const REQUESTABLE = ['TEXT_NUMBER', 'DATE', 'CHECKBOX', 'PICKLIST', 'MULTI_PICKLIST', 'CONTACT_LIST', 'DURATION']

function checkRecipients(rs: readonly Recipient[], cols: readonly Column[], allowOwner: boolean, out: string[]) {
  const usable = rs.filter((r) => allowOwner || r.kind !== 'owner')
  if (usable.length === 0) out.push(allowOwner ? 'Choose who to notify.' : 'Add at least one e-mail address or a column that holds addresses.')
  for (const r of usable) {
    if (r.kind === 'email' && !isEmail(r.email)) out.push(`"${r.email || '(blank)'}" is not a valid e-mail address.`)
    if (r.kind === 'column' && !cols.some((c) => c.id === r.columnId)) out.push('A recipient column no longer exists.')
  }
}

function checkConditions(g: ConditionGroup | null, cols: readonly Column[], out: string[]) {
  if (!g) return
  for (const item of g.items) {
    if (isGroup(item)) {
      checkConditions(item, cols, out)
      continue
    }
    const c: Condition = item
    if (!cols.some((x) => x.id === c.columnId)) out.push('A condition uses a column that no longer exists.')
    else if (opNeedsValue(c.op) && (c.value === undefined || c.value === null || String(c.value).trim() === '')) out.push('A condition needs a value.')
    else if (c.op === 'in_next_days' && !(Number(c.value) >= 0)) out.push('"Within the next (days)" needs a number of days.')
  }
}

export function validateRule(d: RuleDraft, cols: readonly Column[], otherSheetIds: readonly string[]): string[] {
  const out: string[] = []
  const name = d.name.trim()
  if (name === '') out.push('Give the rule a name.')
  else if (name.length > MAX_RULE_NAME) out.push(`The name can be at most ${MAX_RULE_NAME} characters.`)
  const col = (id: string) => cols.find((c) => c.id === id)

  const t = d.trigger
  if (t.type === 'row_changed') for (const id of t.columnIds ?? []) if (!col(id)) out.push('A watched column no longer exists.')
  if (t.type === 'cell_becomes') {
    if (!col(t.columnId)) out.push('Choose the column to watch.')
    else if (isBlank(t.value, col(t.columnId)) && col(t.columnId)!.type !== 'CHECKBOX') out.push('Choose the value the cell must become.')
  }
  if (t.type === 'date') {
    const c = col(t.columnId)
    if (!c || c.type !== 'DATE') out.push('Choose a date column.')
    if (t.when !== 'on' && !(Number.isInteger(t.days) && t.days >= 1 && t.days <= 365)) out.push('Days must be between 1 and 365.')
  }
  if (t.type === 'schedule') {
    if (!parseTime(t.time)) out.push('Choose a time of day.')
    if (t.frequency === 'weekly' && !(Number.isInteger(t.weekday) && t.weekday! >= 0 && t.weekday! <= 6)) out.push('Choose a day of the week.')
    if (t.frequency === 'monthly' && !(Number.isInteger(t.dayOfMonth) && t.dayOfMonth! >= 1 && t.dayOfMonth! <= 31)) out.push('Choose a day of the month (1 to 31).')
  }

  checkConditions(d.conditions, cols, out)

  const a = d.action
  switch (a.type) {
    case 'notify':
      checkRecipients(a.recipients, cols, true, out)
      if (a.include === 'columns' && (a.columnIds ?? []).length === 0) out.push('Choose the columns to include, or include all of them.')
      break
    case 'update_request':
      checkRecipients(a.recipients, cols, false, out)
      if (a.columnIds.length === 0) out.push('Choose at least one column the recipient may update.')
      for (const id of a.columnIds) {
        const c = col(id)
        if (!c) out.push('A column to update no longer exists.')
        else if (!REQUESTABLE.includes(c.type) || c.role === 'predecessor') out.push(`"${c.title}" cannot be edited through a link.`)
      }
      if (!(Number.isInteger(a.expiresInDays) && a.expiresInDays >= 1 && a.expiresInDays <= 90)) out.push('The link can last 1 to 90 days.')
      break
    case 'approval': {
      checkRecipients(a.recipients, cols, false, out)
      const s = col(a.statusColumnId)
      if (!s) out.push('Choose the column that receives the answer.')
      if (!a.approvedValue.trim() || !a.declinedValue.trim()) out.push('Give the value to write for approve and for decline.')
      else if (a.approvedValue.trim().toLowerCase() === a.declinedValue.trim().toLowerCase()) out.push('Approve and decline must write different values.')
      if (s?.type === 'PICKLIST') {
        for (const v of [a.approvedValue, a.declinedValue, ...(a.pendingValue ? [a.pendingValue] : [])]) {
          if (v && !(s.options ?? []).includes(v)) out.push(`"${v}" is not an option of "${s.title}".`)
        }
      }
      if (!(Number.isInteger(a.expiresInDays) && a.expiresInDays >= 1 && a.expiresInDays <= 90)) out.push('The link can last 1 to 90 days.')
      break
    }
    case 'move':
    case 'copy':
      if (!otherSheetIds.includes(a.targetSheetId)) out.push('Choose the sheet to send the row to.')
      break
    case 'record_date': {
      const c = col(a.columnId)
      if (!c || c.type !== 'DATE') out.push('Choose a date column to record the date in.')
      else if (c.role === 'start' || c.role === 'end') out.push('Start and End dates are set by the schedule; choose another date column.')
      break
    }
    case 'lock':
      break
  }
  return out
}
