/**
 * The wizard's request form as data: a list of equipment items, each with its type, name and
 * required date, plus the shared "use the same date for all" convenience. Pure, so the rules
 * (what is valid, which date an item gets, what is sent) are testable without the UI.
 */
import { isAcceptedDate, MAX_DATE, MIN_DATE } from '../model/validate'
import type { Job } from './plannerEntries'
import { MAX_BATCH_ITEMS } from './types'

/** The equipment type select's "type it yourself" choice. */
export const OTHER = '__other__'

export const MAX_ITEMS = MAX_BATCH_ITEMS
const MAX_TYPE_CHARS = 100
const MAX_NAME_CHARS = 200

export interface ItemForm {
  /** Stable React key and the key of the item's results. */
  key: string
  /** A type with history, or OTHER (then `other` holds the text). */
  choice: string
  other: string
  name: string
  /** The item's own date; with "same date for all" on, empty means "use the shared date". */
  date: string
  /** The equipment card that added this item (unticking the card removes it); null for any other item. */
  fromCard: string | null
  /** The Procore cost code ('GEN'), or ''. Client-side only: never sent to the planning server. */
  costCode: string
  /** True once the user picked or cleared the code; until then it follows the item's type. */
  costCodeEdited: boolean
  /** The Procore site project it is delivered to ('BKK-03'), or ''. Client-side only, like the cost code. */
  deliverySite: string
  /** True once the user picked or cleared the site; until then it follows the plan's default site. */
  deliverySiteEdited: boolean
}

export interface ItemErrors {
  type?: string
  name?: string
  date?: string
}

export interface FormValues {
  scheduleType: string
  items: ItemForm[]
  /** "Use the same date for all" (only offered with two or more items). */
  sameDate: boolean
  sharedDate: string
  notes: string
}

let counter = 0
export const newKey = () => `item-${++counter}`

export function newItem(choice: string, fromCard: string | null = null): ItemForm {
  return { key: newKey(), choice, other: '', name: '', date: '', fromCard, costCode: '', costCodeEdited: false, deliverySite: '', deliverySiteEdited: false }
}

/**
 * Keeps each unedited item's cost code in step with its type: the code `codeFor` gives for the chosen
 * type, '' for a typed-in type. Codes the user picked or cleared stay. Returns the same array when
 * nothing changes.
 */
export function syncCostCodes(items: ItemForm[], codeFor: (equipmentType: string) => string): ItemForm[] {
  let changed = false
  const next = items.map((item) => {
    if (item.costCodeEdited) return item
    const code = item.choice === OTHER ? '' : codeFor(item.choice)
    if (code === item.costCode) return item
    changed = true
    return { ...item, costCode: code }
  })
  return changed ? next : items
}

/** The user's own choice of cost code ('' clears it); it no longer follows the type. */
export const setCostCode = (item: ItemForm, code: string): ItemForm => ({ ...item, costCode: code, costCodeEdited: true })

/**
 * Gives each item whose site was not picked or cleared by hand the plan's default site (the plan's
 * Procore project when that is a site, else ''). Returns the same array when nothing changes.
 */
export function syncDeliverySites(items: ItemForm[], defaultSite: string): ItemForm[] {
  let changed = false
  const next = items.map((item) => {
    if (item.deliverySiteEdited || item.deliverySite === defaultSite) return item
    changed = true
    return { ...item, deliverySite: defaultSite }
  })
  return changed ? next : items
}

/** The user's own choice of delivery site ('' clears it); it no longer follows the plan's project. */
export const setDeliverySite = (item: ItemForm, code: string): ItemForm => ({ ...item, deliverySite: code, deliverySiteEdited: true })

/** True for an item the user has not touched: nothing typed or picked beyond the default type. */
export const isPristine = (item: ItemForm) => item.fromCard === null && item.name.trim() === '' && item.date === '' && item.other.trim() === ''

export const itemType = (item: ItemForm) => (item.choice === OTHER ? item.other : item.choice).trim()

/** The date an item is planned to: its own, else the shared one when "same date for all" is on. */
export function effectiveDate(item: ItemForm, form: Pick<FormValues, 'sameDate' | 'sharedDate' | 'items'>): string {
  if (item.date) return item.date
  return form.sameDate && form.items.length > 1 ? form.sharedDate : ''
}

const dateRange = `Enter a date between ${MIN_DATE} and ${MAX_DATE}`

/** Per-item problems, by item key; an item with no entry is fine. */
export function validateItems(form: FormValues, noun = 'equipment'): Record<string, ItemErrors> {
  const shared = form.sameDate && form.items.length > 1
  const errors: Record<string, ItemErrors> = {}
  for (const item of form.items) {
    const e: ItemErrors = {}
    const type = itemType(item)
    if (!type) e.type = `Enter the ${noun} type`
    else if (type.length > MAX_TYPE_CHARS) e.type = `The ${noun} type can be at most ${MAX_TYPE_CHARS} characters`
    const name = item.name.trim()
    if (!name) e.name = `Enter the ${noun} name`
    else if (name.length > MAX_NAME_CHARS) e.name = `The ${noun} name can be at most ${MAX_NAME_CHARS} characters`
    const date = effectiveDate(item, form)
    if (!date) e.date = shared ? 'Enter a date, or fill in the shared date' : `Enter the date the ${noun} must be on site`
    else if (!isAcceptedDate(date)) e.date = dateRange
    if (e.type || e.name || e.date) errors[item.key] = e
  }
  return errors
}

/** The first problem as one sentence, for the form-level alert; "Item 2: ..." when there are several items. */
export function firstProblem(form: FormValues, errors: Record<string, ItemErrors>): string | null {
  if (!form.scheduleType) return 'Choose a schedule type'
  const many = form.items.length > 1
  for (const [i, item] of form.items.entries()) {
    const e = errors[item.key]
    const message = e?.type ?? e?.name ?? e?.date
    if (message) return many ? `Item ${i + 1}: ${message}` : message
  }
  return null
}

/** What the wizard sends for a valid form: the shared fields and one entry per item (keyed by the form item). */
export function jobFromForm(form: FormValues): Job {
  const notes = form.notes.trim()
  return {
    scheduleType: form.scheduleType,
    ...(notes ? { notes } : {}),
    items: form.items.map((item) => ({
      key: item.key,
      equipmentType: itemType(item),
      equipmentName: item.name.trim(),
      requiredDate: effectiveDate(item, form),
    })),
  }
}

/**
 * Adds an item for an equipment card. Untouched placeholder items make way for it (so ticking two
 * cards on a fresh form gives two items, not three).
 */
export function addCardItem(items: ItemForm[], type: string): ItemForm[] {
  if (items.length >= MAX_ITEMS && items.every((i) => !isPristine(i))) return items
  const kept = items.filter((i) => !isPristine(i))
  return [...kept, newItem(type, type)]
}

/** Unticking a card removes the item it added; the form never goes below one (blank) item. */
export function removeCardItem(items: ItemForm[], type: string, defaultChoice: string): ItemForm[] {
  const next = items.filter((i) => i.fromCard !== type)
  return next.length > 0 ? next : [newItem(defaultChoice)]
}

/** Removes one item; the form never goes below one (blank) item. */
export function removeItem(items: ItemForm[], key: string, defaultChoice: string): ItemForm[] {
  const next = items.filter((i) => i.key !== key)
  return next.length > 0 ? next : [newItem(defaultChoice)]
}
