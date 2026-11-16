/** Plain-language summaries of rules, for the rule list and the builder. Pure. */
import type { Column } from '../model/validate'
import { CONDITION_OPS, opNeedsValue } from './conditions'
import type { Action, AutomationRule, Condition, ConditionGroup, Recipient, Trigger } from './types'
import { isGroup } from './types'
import { formatValue } from './values'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const title = (cols: readonly Column[], id: string) => cols.find((c) => c.id === id)?.title ?? '(deleted column)'
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

export function describeTrigger(t: Trigger, cols: readonly Column[]): string {
  switch (t.type) {
    case 'row_added':
      return 'a row is added'
    case 'row_changed':
      return t.columnIds && t.columnIds.length > 0
        ? `a row is changed in ${t.columnIds.map((id) => title(cols, id)).join(' or ')}`
        : 'a row is changed'
    case 'cell_becomes':
      return `${title(cols, t.columnId)} becomes ${formatValue(t.value) || '(blank)'}`
    case 'date':
      return t.when === 'on'
        ? `the ${title(cols, t.columnId)} date arrives`
        : `${plural(t.days, 'day')} ${t.when} the ${title(cols, t.columnId)} date`
    case 'schedule': {
      const at = `at ${t.time}`
      if (t.frequency === 'daily') return `every day ${at}`
      if (t.frequency === 'weekly') return `every ${WEEKDAYS[t.weekday ?? 1]} ${at}`
      return `on day ${t.dayOfMonth ?? 1} of every month ${at}`
    }
  }
}

export function describeCondition(c: Condition, cols: readonly Column[]): string {
  const label = CONDITION_OPS.find((o) => o.op === c.op)?.label ?? c.op
  const value = opNeedsValue(c.op) ? ` ${c.op === 'in_next_days' ? formatValue(c.value) : `"${formatValue(c.value)}"`}` : ''
  return `${title(cols, c.columnId)} ${label}${value}`
}

export function describeConditions(g: ConditionGroup | null, cols: readonly Column[]): string {
  if (!g || g.items.length === 0) return ''
  const parts = g.items.map((i) => (isGroup(i) ? `(${describeConditions(i, cols)})` : describeCondition(i, cols)))
  return parts.join(g.op === 'and' ? ' and ' : ' or ')
}

export function describeRecipients(rs: readonly Recipient[], cols: readonly Column[]): string {
  if (rs.length === 0) return 'nobody'
  return rs
    .map((r) => (r.kind === 'owner' ? 'me (in the app)' : r.kind === 'email' ? r.email : `the people in ${title(cols, r.columnId)}`))
    .join(', ')
}

export function describeAction(a: Action, cols: readonly Column[]): string {
  switch (a.type) {
    case 'notify': {
      const when = a.frequency === 'immediately' ? '' : a.frequency === 'daily' ? ' in a daily digest' : ' in a weekly digest'
      return `notify ${describeRecipients(a.recipients, cols)}${when}`
    }
    case 'update_request':
      return `ask ${describeRecipients(a.recipients, cols)} to update ${a.columnIds.map((id) => title(cols, id)).join(', ') || 'the row'}`
    case 'approval':
      return `ask ${describeRecipients(a.recipients, cols)} to approve, and write the answer to ${title(cols, a.statusColumnId)}`
    case 'lock':
      return a.locked ? 'lock the row' : 'unlock the row'
    case 'move':
      return 'move the row to another sheet'
    case 'copy':
      return 'copy the row to another sheet'
    case 'record_date':
      return `record today's date in ${title(cols, a.columnId)}`
  }
}

/** "When Status becomes Done, and Priority is "High", notify me (in the app)." */
export function describeRule(rule: Pick<AutomationRule, 'trigger' | 'conditions' | 'action'>, cols: readonly Column[]): string {
  const conds = describeConditions(rule.conditions, cols)
  const trig = describeTrigger(rule.trigger, cols)
  const lead = rule.trigger.type === 'schedule' ? `${cap(trig)}` : `When ${trig}`
  const rows = rule.trigger.type === 'schedule' ? ', for each row' : ''
  return `${lead}${rows}${conds ? `, and ${conds}` : ''}: ${describeAction(rule.action, cols)}.`
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
