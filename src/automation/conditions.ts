/** Evaluating conditions against a row. Pure and deterministic: "today" comes from the caller. */
import type { Column } from '../model/validate'
import { isGroup, type Condition, type ConditionGroup, type ConditionOp } from './types'
import { addDays, isIsoDate } from './time'
import { compareValues, containsValue, isBlank, looseEquals, type Cells } from './values'

export interface CondEnv {
  columns: readonly Column[]
  /** The row now. */
  cells: Cells
  /** The row before the change; absent when nothing changed (a schedule tick), so `changed*` is false. */
  before?: Cells
  /** The date it is today (YYYY-MM-DD). */
  today: string
}

export const CONDITION_OPS: { op: ConditionOp; label: string; needsValue: boolean }[] = [
  { op: 'is', label: 'is', needsValue: true },
  { op: 'is_not', label: 'is not', needsValue: true },
  { op: 'contains', label: 'contains', needsValue: true },
  { op: 'not_contains', label: 'does not contain', needsValue: true },
  { op: 'gt', label: 'is greater than', needsValue: true },
  { op: 'lt', label: 'is less than', needsValue: true },
  { op: 'gte', label: 'is at least', needsValue: true },
  { op: 'lte', label: 'is at most', needsValue: true },
  { op: 'is_blank', label: 'is blank', needsValue: false },
  { op: 'is_not_blank', label: 'is not blank', needsValue: false },
  { op: 'is_today', label: 'is today', needsValue: false },
  { op: 'is_past', label: 'is in the past', needsValue: false },
  { op: 'is_future', label: 'is in the future', needsValue: false },
  { op: 'in_next_days', label: 'is within the next (days)', needsValue: true },
  { op: 'changed', label: 'has changed', needsValue: false },
  { op: 'changed_to', label: 'changed to', needsValue: true },
  { op: 'changed_from', label: 'changed from', needsValue: true },
]

export const opNeedsValue = (op: ConditionOp) => CONDITION_OPS.find((o) => o.op === op)?.needsValue ?? false

export function evaluateCondition(c: Condition, env: CondEnv): boolean {
  const col = env.columns.find((x) => x.id === c.columnId)
  if (!col) return false // the column was deleted: the condition can never hold
  const v = env.cells[c.columnId]
  const prev = env.before ? env.before[c.columnId] : v
  const dateOf = (x: unknown) => (isIsoDate(x) ? x : null)

  switch (c.op) {
    case 'is':
      return looseEquals(v, c.value, col)
    case 'is_not':
      return !looseEquals(v, c.value, col)
    case 'contains':
      return containsValue(v, c.value)
    case 'not_contains':
      return !containsValue(v, c.value)
    case 'gt':
    case 'lt':
    case 'gte':
    case 'lte': {
      const d = compareValues(v, c.value)
      if (d === null) return false
      return c.op === 'gt' ? d > 0 : c.op === 'lt' ? d < 0 : c.op === 'gte' ? d >= 0 : d <= 0
    }
    case 'is_blank':
      return isBlank(v, col)
    case 'is_not_blank':
      return !isBlank(v, col)
    case 'is_today':
      return dateOf(v) === env.today
    case 'is_past': {
      const d = dateOf(v)
      return d !== null && d < env.today
    }
    case 'is_future': {
      const d = dateOf(v)
      return d !== null && d > env.today
    }
    case 'in_next_days': {
      const d = dateOf(v)
      const n = Number(c.value)
      if (d === null || !Number.isFinite(n) || n < 0) return false
      return d >= env.today && d <= addDays(env.today, Math.floor(n))
    }
    case 'changed':
      return env.before !== undefined && !looseEquals(prev, v, col)
    case 'changed_to':
      return env.before !== undefined && !looseEquals(prev, v, col) && looseEquals(v, c.value, col)
    case 'changed_from':
      return env.before !== undefined && !looseEquals(prev, v, col) && looseEquals(prev, c.value, col)
  }
}

/** A group holds when all (and) or any (or) of its items hold. An empty group holds. */
export function evaluateGroup(g: ConditionGroup | null | undefined, env: CondEnv): boolean {
  if (!g || g.items.length === 0) return true
  const test = (item: Condition | ConditionGroup) => (isGroup(item) ? evaluateGroup(item, env) : evaluateCondition(item, env))
  return g.op === 'and' ? g.items.every(test) : g.items.some(test)
}

export interface ConditionOutcome {
  text: string
  pass: boolean
}

/** Each leaf condition with its result, for the test run's explanation. */
export function explainGroup(g: ConditionGroup | null | undefined, env: CondEnv, describe: (c: Condition) => string): ConditionOutcome[] {
  if (!g) return []
  const out: ConditionOutcome[] = []
  for (const item of g.items) {
    if (isGroup(item)) out.push(...explainGroup(item, env, describe))
    else out.push({ text: describe(item), pass: evaluateCondition(item, env) })
  }
  return out
}
