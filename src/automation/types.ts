/**
 * The shapes of automation rules, shared by the engine (pure), the browser runtime, the Automation
 * page and the server. Rules are stored as JSON (`automation_rules.trigger / conditions / action`),
 * so everything here is plain data. Behaviour follows docs/superpowers/specs/2026-11-16-smartsheet-feature-gap.md
 * section 6 (a trigger, optional conditions, one action); no code of any other product is used.
 */

// ---- Triggers ----

export type Trigger =
  /** A row is added to the sheet. */
  | { type: 'row_added' }
  /** A row is changed: any column, or only the listed columns when `columnIds` is not empty. */
  | { type: 'row_changed'; columnIds?: string[] }
  /** A cell becomes a value (e.g. Status = Done): fires when the column changes TO `value`. */
  | { type: 'cell_becomes'; columnId: string; value: unknown }
  /**
   * A date arrives: `days` days before / on / after the date in a DATE column (`days` is ignored for
   * `on`). Fires once per row and date, on the day itself.
   */
  | { type: 'date'; columnId: string; when: 'before' | 'on' | 'after'; days: number }
  /** A recurring schedule; the rule then acts on every row that meets the conditions. */
  | { type: 'schedule'; frequency: 'daily' | 'weekly' | 'monthly'; time: string; weekday?: number; dayOfMonth?: number }

export type TriggerType = Trigger['type']

// ---- Conditions ----

export type ConditionOp =
  | 'is'
  | 'is_not'
  | 'contains'
  | 'not_contains'
  | 'gt'
  | 'lt'
  | 'gte'
  | 'lte'
  | 'is_blank'
  | 'is_not_blank'
  | 'is_today'
  | 'is_past'
  | 'is_future'
  | 'in_next_days'
  | 'changed'
  | 'changed_to'
  | 'changed_from'

export interface Condition {
  columnId: string
  op: ConditionOp
  value?: unknown
}

/** AND / OR group of comparisons and nested groups. An empty group is true. */
export interface ConditionGroup {
  op: 'and' | 'or'
  items: (Condition | ConditionGroup)[]
}

export const isGroup = (c: Condition | ConditionGroup): c is ConditionGroup => 'items' in c

// ---- Actions ----

export type Recipient =
  /** The people in a contact column of the row (a cell may hold several addresses). */
  | { kind: 'column'; columnId: string }
  /** A fixed address. */
  | { kind: 'email'; email: string }
  /** The rule's owner (the signed-in user): delivered in the app. */
  | { kind: 'owner' }

export type Frequency = 'immediately' | 'daily' | 'weekly'

export interface NotifyAction {
  type: 'notify'
  recipients: Recipient[]
  frequency: Frequency
  subject?: string
  /** Free text; `{{Column title}}` is replaced by the row's value. */
  message?: string
  /** What to show of the row: every column, only `columnIds`, or none. */
  include: 'all' | 'columns' | 'none'
  columnIds?: string[]
  linkToRow: boolean
  /**
   * Also send it on WhatsApp: to each recipient e-mail that belongs to a linked planner user or an
   * active site contact of the owner, and to the owner's own linked phone for "me". Resolved by the
   * server (server/whatsapp/alerts.ts); recipients without WhatsApp are skipped.
   */
  whatsapp?: boolean
}

/** recipient_email of a WhatsApp notification meant for the rule's owner (the server finds the phone). */
export const WHATSAPP_OWNER_RECIPIENT = '(owner)'

export interface UpdateRequestAction {
  type: 'update_request'
  recipients: Recipient[]
  /** Columns the recipient may edit. */
  columnIds: string[]
  message?: string
  /** Days the link stays valid (1..90). */
  expiresInDays: number
}

export interface ApprovalAction {
  type: 'approval'
  recipients: Recipient[]
  /** The cell that receives the outcome. */
  statusColumnId: string
  pendingValue?: string
  approvedValue: string
  declinedValue: string
  /** Columns shown to the approver (read only). */
  showColumnIds?: string[]
  message?: string
  expiresInDays: number
}

export interface LockAction {
  type: 'lock'
  locked: boolean
}

export interface MoveCopyAction {
  type: 'move' | 'copy'
  targetSheetId: string
}

export interface RecordDateAction {
  type: 'record_date'
  columnId: string
}

export type Action = NotifyAction | UpdateRequestAction | ApprovalAction | LockAction | MoveCopyAction | RecordDateAction

export type ActionType = Action['type']

// ---- Rules ----

export interface AutomationRule {
  id: string
  sheetId: string
  name: string
  enabled: boolean
  trigger: Trigger
  conditions: ConditionGroup | null
  action: Action
  /** ISO timestamps. */
  createdAt: string
  lastRunAt?: string | null
}

// ---- Engine input ----

export interface RowSnapshot {
  id: string
  cells: Record<string, unknown>
}

export type SheetEvent =
  | {
      kind: 'row_added'
      row: RowSnapshot
      /** Ids of the rules whose actions led to this event (loop protection). */
      origin?: string[]
    }
  | {
      kind: 'row_changed'
      before: RowSnapshot
      after: RowSnapshot
      origin?: string[]
    }

// ---- Engine output ----

export interface NotifyItem {
  rowId: string
  label: string
  /** Column title / formatted value pairs chosen by the action's `include`. */
  values: { title: string; value: string }[]
}

export type PlannedAction =
  | {
      type: 'notify'
      /** Show it in the notification centre of the rule's owner. */
      inApp: boolean
      emails: string[]
      /** Also on WhatsApp (see NotifyAction.whatsapp). */
      whatsapp?: boolean
      frequency: Frequency
      subject: string
      message: string
      items: NotifyItem[]
      linkRowId: string | null
      /** When it may be delivered (ms since epoch): now for immediate, the next digest time otherwise. */
      deliverAfter: number
    }
  | { type: 'update_request'; rowId: string; emails: string[]; columnIds: string[]; message: string; expiresInDays: number }
  | {
      type: 'approval'
      rowId: string
      emails: string[]
      statusColumnId: string
      pendingValue: string | null
      approvedValue: string
      declinedValue: string
      showColumnIds: string[]
      message: string
      expiresInDays: number
    }
  | { type: 'set_cell'; rowId: string; columnId: string; value: unknown }
  | { type: 'lock'; rowId: string; locked: boolean }
  | { type: 'move' | 'copy'; rowId: string; targetSheetId: string }

export interface PlannedRun {
  ruleId: string
  ruleName: string
  rowId: string | null
  rowLabel: string
  /** Set for time based runs: the run is recorded once per key (unique per rule). */
  dedupKey: string | null
  actions: PlannedAction[]
  /** Why nothing (or less) happened, in words: no recipients, no row met the conditions... */
  notes?: string[]
}

export type SkipReason = 'loop' | 'depth' | 'throttled' | 'locked'

export interface SkippedRun {
  ruleId: string
  ruleName: string
  rowId: string | null
  reason: SkipReason
}

export interface EvalResult {
  runs: PlannedRun[]
  skipped: SkippedRun[]
}
