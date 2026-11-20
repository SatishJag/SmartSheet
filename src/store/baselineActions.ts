import {
  compareToBaseline,
  snapshotSchedule,
  type BaselineComparison,
  type BaselineMeta,
  type BaselineRow,
} from '../engine/baseline'
import type { Persistence } from './persistence'
import type { ActionResult, SheetState } from './sheetStore'

export const MAX_BASELINE_SLOT = 5
export const MAX_BASELINE_NAME_LENGTH = 100

/** The baseline actions of the sheet store (docs/superpowers/specs/2026-11-15-baselines-design.md). */
export interface BaselineActions {
  /**
   * Freezes the current schedule into `slot` (1-5), replacing that slot's baseline. Refused when the
   * name is blank or over 100 characters, or when no row is scheduled yet. Rows that cannot be
   * scheduled (for example because of a dependency cycle) are left out and a notice says how many.
   * Not optimistic: nothing changes until the database has the baseline, and a failure leaves the
   * state as it was. Independent of the cell save queue and its status.
   */
  saveBaseline(slot: number, name: string): Promise<ActionResult>
  /** Deletes a baseline (not optimistic, like saving). */
  deleteBaseline(baselineId: string): Promise<ActionResult>
  /** Loads a baseline's rows into `baselineRows` (a no-op when they are cached already). */
  loadBaselineRows(baselineId: string): Promise<ActionResult>
}

/** What the baseline actions need from the store. */
export interface BaselineActionContext {
  p: Persistence
  get(): SheetState
  set(partial: Partial<SheetState>): void
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function createBaselineActions(ctx: BaselineActionContext): BaselineActions {
  const { p, get, set } = ctx

  /** One save or delete at a time: a second one would race the first on the same slot. */
  let busy = false
  /** Row loads in flight, so a view asking twice does not fetch twice. */
  const loading = new Map<string, Promise<ActionResult>>()

  /** Runs `fn` as the only save/delete in progress. */
  async function exclusive(fn: () => Promise<ActionResult>): Promise<ActionResult> {
    if (busy) return { ok: false, error: 'Another baseline change is still in progress' }
    busy = true
    try {
      return await fn()
    } finally {
      busy = false
    }
  }

  const withoutBaseline = (cache: Record<string, BaselineRow[]>, id: string) => {
    const { [id]: _gone, ...rest } = cache
    return rest
  }

  return {
    saveBaseline(slot, rawName) {
      return exclusive(async () => {
        const data = get().data
        if (!data) return { ok: false, error: 'Sheet is not loaded' }
        if (!Number.isInteger(slot) || slot < 1 || slot > MAX_BASELINE_SLOT) {
          return { ok: false, error: `Baseline slot must be a whole number from 1 to ${MAX_BASELINE_SLOT}` }
        }
        const name = rawName.trim()
        if (name.length === 0 || name.length > MAX_BASELINE_NAME_LENGTH) {
          return { ok: false, error: `Baseline name must be 1 to ${MAX_BASELINE_NAME_LENGTH} characters` }
        }
        const rows = snapshotSchedule(get().scheduled)
        if (rows.length === 0) {
          return { ok: false, error: 'Nothing to baseline yet: no task has scheduled dates' }
        }
        const sheetId = data.sheet.id
        const leftOut = data.rows.filter((r) => !(r.id in get().scheduled.byRow)).length

        let meta: BaselineMeta
        try {
          meta = await p.saveBaseline(sheetId, slot, name, rows)
        } catch (e) {
          return { ok: false, error: errorMessage(e) }
        }

        const now = get()
        // Another sheet was opened meanwhile: the baseline is saved, but this state is not its sheet.
        if (now.data?.sheet.id !== sheetId) return { ok: true }
        const previous = (now.data.baselines ?? []).filter((b) => b.slot === slot)
        const baselines = [...(now.data.baselines ?? []).filter((b) => b.slot !== slot), meta].sort((a, b) => a.slot - b.slot)
        let cache = { ...now.baselineRows, [meta.id]: rows }
        for (const old of previous) cache = withoutBaseline(cache, old.id)
        const skipped = leftOut > 0 ? ` ${plural(leftOut, 'row')} could not be scheduled and ${leftOut === 1 ? 'was' : 'were'} left out.` : ''
        set({
          data: { ...now.data, baselines },
          baselineRows: cache,
          notices: [...now.notices, `Saved baseline "${name}" in slot ${slot} (${plural(rows.length, 'row')}).${skipped}`],
        })
        return { ok: true }
      })
    },

    deleteBaseline(baselineId) {
      return exclusive(async () => {
        const data = get().data
        if (!data) return { ok: false, error: 'Sheet is not loaded' }
        const target = (data.baselines ?? []).find((b) => b.id === baselineId)
        if (!target) return { ok: false, error: 'That baseline no longer exists' }
        try {
          await p.deleteBaseline(baselineId)
        } catch (e) {
          return { ok: false, error: errorMessage(e) }
        }
        const now = get()
        if (now.data?.sheet.id !== data.sheet.id) return { ok: true }
        set({
          data: { ...now.data, baselines: (now.data.baselines ?? []).filter((b) => b.id !== baselineId) },
          baselineRows: withoutBaseline(now.baselineRows, baselineId),
          notices: [...now.notices, `Deleted baseline "${target.name}".`],
        })
        return { ok: true }
      })
    },

    loadBaselineRows(baselineId) {
      const data = get().data
      if (!data) return Promise.resolve({ ok: false, error: 'Sheet is not loaded' })
      if (!(data.baselines ?? []).some((b) => b.id === baselineId)) {
        return Promise.resolve({ ok: false, error: 'That baseline no longer exists' })
      }
      if (get().baselineRows[baselineId]) return Promise.resolve({ ok: true })
      const pending = loading.get(baselineId)
      if (pending) return pending
      const sheetId = data.sheet.id
      const run = (async (): Promise<ActionResult> => {
        try {
          const rows = await p.loadBaselineRows(baselineId)
          const now = get()
          // Dropped meanwhile (sheet changed, baseline replaced or deleted): do not cache stale rows.
          if (now.data?.sheet.id === sheetId && (now.data.baselines ?? []).some((b) => b.id === baselineId)) {
            set({ baselineRows: { ...now.baselineRows, [baselineId]: rows } })
          }
          return { ok: true }
        } catch (e) {
          return { ok: false, error: errorMessage(e) }
        } finally {
          loading.delete(baselineId)
        }
      })()
      loading.set(baselineId, run)
      return run
    },
  }
}

type ComparisonCacheEntry = {
  meta: BaselineMeta
  scheduled: SheetState['scheduled']
  calendar: NonNullable<SheetState['data']>['sheet']['calendar']
  result: BaselineComparison
}
/** Keyed by the cached rows array, so a comparison is recomputed only when its inputs change. */
const comparisons = new WeakMap<BaselineRow[], ComparisonCacheEntry>()

/**
 * The live schedule compared with one baseline, or null while its rows are not loaded (or the
 * baseline is unknown). Pure selector: the result is memoized on the inputs' identity, so it is
 * safe to use as a zustand/React selector (the same object comes back until something changes).
 */
export function baselineComparison(
  state: Pick<SheetState, 'data' | 'scheduled' | 'baselineRows'>,
  baselineId: string,
): BaselineComparison | null {
  const data = state.data
  const meta = data?.baselines?.find((b) => b.id === baselineId)
  const rows = state.baselineRows[baselineId]
  if (!data || !meta || !rows) return null
  const calendar = data.sheet.calendar
  const hit = comparisons.get(rows)
  if (hit && hit.scheduled === state.scheduled && hit.calendar === calendar && hit.meta === meta) return hit.result
  const result = compareToBaseline(calendar, state.scheduled, { ...meta, rows })
  comparisons.set(rows, { meta, scheduled: state.scheduled, calendar, result })
  return result
}
