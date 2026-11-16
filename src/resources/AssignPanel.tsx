import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { StoreApi } from 'zustand/vanilla'
import { useSheetStore } from '../store/SheetStoreContext'
import { Icon } from '../ui/Icon'
import { Drawer } from './Drawer'
import { Field } from './Field'
import {
  ALLOCATION_LABEL,
  ALLOCATION_MAX,
  fmtAllocation,
  fmtDay,
  fmtHours,
  fmtShort,
} from './format'
import {
  bucketsFor,
  findAvailable,
  isoOfDay,
  previewAssignment,
  type Allocation,
  type AllocationKind,
  type Assignment,
  type TaskFact,
} from './engine'
import { supabaseResourcePersistence } from './persistence'
import { createResourceStore, loadModel, type ResourceState } from './resourceStore'
import { ResourceStoreProvider, useResourceStore, useResourceStoreApi } from './ResourceStoreContext'
import { taskFactsFromSheet } from './taskFacts'
import './resources.css'

const DEFAULT_VALUE: Record<AllocationKind, string> = { percent: '100', hours_per_day: '8', hours_per_week: '40', total_hours: '40' }

/**
 * The sheet toolbar's "Resources" button and the side panel it opens: assign resources to the selected
 * tasks with an allocation, see the resource's load that week, and get a warning before they are over-allocated.
 * Nothing is read from the database until the panel is first opened.
 */
export function ResourcesButton({ client, sheetId }: { client: SupabaseClient; sheetId: string }) {
  const [open, setOpen] = useState(false)
  const storeRef = useRef<StoreApi<ResourceState> | null>(null)
  const toggle = () => {
    if (!storeRef.current) storeRef.current = createResourceStore(supabaseResourcePersistence(client))
    setOpen((o) => !o)
  }
  return (
    <>
      <button type="button" aria-expanded={open} aria-label="Assign resources" title="Assign resources to tasks" onClick={toggle}>
        <Icon name="users" size={16} />
        <span className="hide-sm">Resources</span>
      </button>
      {open &&
        storeRef.current &&
        createPortal(
          <ResourceStoreProvider store={storeRef.current}>
            <AssignPanel sheetId={sheetId} onClose={() => setOpen(false)} />
          </ResourceStoreProvider>,
          document.body,
        )}
    </>
  )
}

/** The leaf task a grid cell or Gantt bar belongs to, when the user focuses or clicks one. */
function useTaskSelectionFromSheet(panel: RefObject<HTMLElement | null>, onPick: (rowId: string) => void) {
  const pick = useRef(onPick)
  pick.current = onPick
  useEffect(() => {
    const handler = (e: Event) => {
      const t = e.target as HTMLElement | null
      if (!t || panel.current?.contains(t)) return
      const row = t.closest?.('[data-row-id]')?.getAttribute('data-row-id')
      if (row) pick.current(row)
    }
    document.addEventListener('focusin', handler)
    document.addEventListener('click', handler)
    return () => {
      document.removeEventListener('focusin', handler)
      document.removeEventListener('click', handler)
    }
  }, [panel])
}

export function AssignPanel({ sheetId, onClose }: { sheetId: string; onClose: () => void }) {
  const store = useResourceStoreApi()
  const data = useSheetStore((s) => s.data)
  const scheduled = useSheetStore((s) => s.scheduled)
  const facts = useMemo(() => (data ? taskFactsFromSheet(data, scheduled) : []), [data, scheduled])
  const sheetName = data?.sheet.name ?? ''
  const hasStart = !!data?.columns.some((c) => c.role === 'start')

  const resources = useResourceStore((s) => s.resources)
  const assignments = useResourceStore((s) => s.assignments)
  const loaded = useResourceStore((s) => s.loaded)
  const tasksLoading = useResourceStore((s) => s.tasksLoading)
  const loadError = useResourceStore((s) => s.loadError)
  const model = useResourceStore(loadModel)

  // Load everything once, and keep this sheet's tasks live so assignments follow the schedule.
  useEffect(() => {
    store.getState().setLiveSheet(sheetId, sheetName, facts)
  }, [store, sheetId, sheetName, facts])
  useEffect(() => {
    void store.getState().loadAll()
  }, [store])

  const panelRef = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const factById = useMemo(() => new Map(facts.map((t) => [t.rowId, t])), [facts])
  const chosen = selected.map((id) => factById.get(id)).filter((t): t is TaskFact => !!t)

  useTaskSelectionFromSheet(panelRef, (rowId) => {
    if (factById.has(rowId)) setSelected([rowId])
  })

  const here = assignments.filter((a) => a.sheetId === sheetId)
  const byTask = useMemo(() => {
    const m = new Map<string, Assignment[]>()
    for (const a of here) (m.get(a.rowId) ?? m.set(a.rowId, []).get(a.rowId)!).push(a)
    return m
  }, [here])
  const resourceName = useMemo(() => new Map(resources.map((r) => [r.id, r.name])), [resources])

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return facts.filter((t) => !q || t.name.toLowerCase().includes(q))
  }, [facts, search])
  const LIMIT = 120

  const toggleTask = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  return (
    <div ref={panelRef}>
      <Drawer title="Assign resources" subtitle={sheetName} onClose={onClose}>
        {!hasStart ? (
          <p className="res-hint">This sheet has no Start column, so its tasks have no dates to plan work against. Add a Start column or use the Project schedule template.</p>
        ) : facts.length === 0 ? (
          <p className="res-hint">Nothing is scheduled yet. Give tasks a start date and a duration, then assign people to them.</p>
        ) : (
          <>
            {loadError && (
              <p role="alert" className="res-alert">
                {loadError}
              </p>
            )}
            <section aria-label="Tasks" className="asg-block">
              <div className="asg-block-head">
                <h3 className="res-h3">Tasks</h3>
                <span className="res-hint">
                  {selected.length === 0 ? 'Pick tasks, or click one in the sheet' : `${selected.length} selected`}
                </span>
              </div>
              <input type="search" aria-label="Search tasks" placeholder="Search tasks…" value={search} onChange={(e) => setSearch(e.currentTarget.value)} />
              <ul className="asg-tasks">
                {shown.slice(0, LIMIT).map((t) => {
                  const list = byTask.get(t.rowId) ?? []
                  return (
                    <li key={t.rowId}>
                      <label className={selected.includes(t.rowId) ? 'is-picked' : undefined}>
                        <input type="checkbox" checked={selected.includes(t.rowId)} onChange={() => toggleTask(t.rowId)} />
                        <span className="asg-task-name">
                          <strong>{t.name}</strong>
                          <small>
                            {t.durationDays === 0 ? `Milestone ${fmtShort(t.start)}` : `${fmtShort(t.start)} to ${fmtShort(t.end)}`}
                          </small>
                        </span>
                        {list.length > 0 && (
                          <span className="asg-chips" aria-label={`Assigned: ${list.map((a) => resourceName.get(a.resourceId) ?? '?').join(', ')}`}>
                            {list.slice(0, 3).map((a) => (
                              <span key={a.id} className="chip">
                                {initials(resourceName.get(a.resourceId) ?? '?')}
                              </span>
                            ))}
                            {list.length > 3 && <span className="chip">+{list.length - 3}</span>}
                          </span>
                        )}
                      </label>
                    </li>
                  )
                })}
              </ul>
              {shown.length > LIMIT && <p className="res-hint">Showing the first {LIMIT} of {shown.length}. Search to narrow the list.</p>}
              {shown.length === 0 && <p className="res-hint">No task matches “{search}”.</p>}
            </section>

            {chosen.length > 0 && (
              <>
                <Existing chosen={chosen} byTask={byTask} resourceName={resourceName} model={model} />
                {!loaded ? (
                  <p className="res-hint" role="status">
                    Loading resources…
                  </p>
                ) : resources.length === 0 ? (
                  <p className="res-hint">
                    You have no resources yet. Add some on the Resources page (top bar), then come back to assign them.
                  </p>
                ) : (
                  <AssignForm chosen={chosen} tasksLoading={tasksLoading} onDone={() => undefined} />
                )}
              </>
            )}
          </>
        )}
      </Drawer>
    </div>
  )
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('')

/** What is already assigned to the selected tasks, with a way to take someone off. */
function Existing({
  chosen,
  byTask,
  resourceName,
  model,
}: {
  chosen: TaskFact[]
  byTask: Map<string, Assignment[]>
  resourceName: Map<string, string>
  model: ReturnType<typeof loadModel>
}) {
  const store = useResourceStoreApi()
  const [error, setError] = useState<string | null>(null)
  const rows = chosen.filter((t) => (byTask.get(t.rowId) ?? []).length > 0)
  if (rows.length === 0) return <p className="res-hint">Nobody is assigned to {chosen.length === 1 ? 'this task' : 'these tasks'} yet.</p>
  return (
    <section aria-label="Assigned resources" className="asg-block">
      <h3 className="res-h3">Assigned</h3>
      {error && (
        <p role="alert" className="res-alert">
          {error}
        </p>
      )}
      {rows.slice(0, 6).map((t) => (
        <div key={t.rowId} className="asg-existing">
          {chosen.length > 1 && <strong>{t.name}</strong>}
          <ul>
            {(byTask.get(t.rowId) ?? []).map((a) => {
              const spread = model.byResource.get(a.resourceId)?.spreads.find((s) => s.assignmentId === a.id)
              const total = spread ? spread.hours.reduce((x, y) => x + y, 0) : 0
              const name = resourceName.get(a.resourceId) ?? 'Resource'
              return (
                <li key={a.id}>
                  <span>
                    <strong>{name}</strong>
                    <small>
                      {fmtAllocation(a.allocation)} · {fmtHours(total)} h
                      {a.startDate || a.endDate ? ` · own dates ${a.startDate ? fmtShort(a.startDate) : 'task start'} to ${a.endDate ? fmtShort(a.endDate) : 'task end'}` : ''}
                    </small>
                  </span>
                  <button
                    type="button"
                    className="btn-icon is-danger"
                    aria-label={`Remove ${name} from ${t.name}`}
                    onClick={async () => {
                      const r = await store.getState().unassign(a.id)
                      setError(r.ok ? null : r.error)
                    }}
                  >
                    <Icon name="trash" size={16} />
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
      {rows.length > 6 && <p className="res-hint">…and {rows.length - 6} more tasks with assignments.</p>}
    </section>
  )
}

function AssignForm({ chosen, tasksLoading, onDone }: { chosen: TaskFact[]; tasksLoading: boolean; onDone(): void }) {
  const store = useResourceStoreApi()
  const resources = useResourceStore((s) => s.resources)
  const assignments = useResourceStore((s) => s.assignments)
  const model = useResourceStore(loadModel)
  const uid = useId()
  const [resourceId, setResourceId] = useState('')
  const [kind, setKind] = useState<AllocationKind>('percent')
  const [value, setValue] = useState(DEFAULT_VALUE.percent)
  const [ownDates, setOwnDates] = useState(false)
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const window = useMemo(() => {
    const starts = chosen.map((t) => (ownDates && start ? start : t.start))
    const ends = chosen.map((t) => (ownDates && end ? end : t.end))
    return { from: starts.reduce((a, b) => (a < b ? a : b)), to: ends.reduce((a, b) => (a > b ? a : b)) }
  }, [chosen, ownDates, start, end])

  // Most free time in the window first, so the best choice is at the top of the list.
  const options = useMemo(() => {
    const free = new Map(findAvailable(model, { from: window.from, to: window.to }).map((a) => [a.resourceId, a]))
    return [...resources].sort((a, b) => (free.get(b.id)?.freeHours ?? 0) - (free.get(a.id)?.freeHours ?? 0) || a.name.localeCompare(b.name)).map((r) => ({ r, free: free.get(r.id)?.freeHours ?? 0 }))
  }, [resources, model, window])

  // Editing: pick the resource of an existing assignment and its numbers come into the form.
  useEffect(() => {
    if (!resourceId || chosen.length !== 1) return
    const ex = assignments.find((a) => a.sheetId === chosen[0].sheetId && a.rowId === chosen[0].rowId && a.resourceId === resourceId)
    if (ex) {
      setKind(ex.allocation.kind)
      setValue(String(ex.allocation.value))
      setOwnDates(!!(ex.startDate || ex.endDate))
      setStart(ex.startDate ?? '')
      setEnd(ex.endDate ?? '')
    }
  }, [resourceId, chosen, assignments])

  const num = Number(value)
  const valueError =
    value.trim() === '' || !Number.isFinite(num) || num <= 0
      ? 'Enter an amount above 0'
      : num > ALLOCATION_MAX[kind]
        ? `At most ${ALLOCATION_MAX[kind]} for ${ALLOCATION_LABEL[kind].toLowerCase()}`
        : null
  const dateError = ownDates && start && end && end < start ? 'The end cannot be before the start' : null
  const allocation: Allocation = { kind, value: valueError ? 1 : num }
  const overrides = { startDate: ownDates && start ? start : null, endDate: ownDates && end ? end : null }

  const previews = useMemo(() => {
    if (!resourceId || valueError || dateError) return null
    return chosen.map((t) => {
      const ex = assignments.find((a) => a.sheetId === t.sheetId && a.rowId === t.rowId && a.resourceId === resourceId)
      return { task: t, p: previewAssignment(model, resourceId, t, allocation, overrides, ex?.id) }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, resourceId, chosen, kind, value, ownDates, start, end, assignments])

  const totalHours = previews?.reduce((s, x) => s + x.p.totalHours, 0) ?? 0
  const overDays = useMemo(() => {
    const set = new Set<number>()
    for (const x of previews ?? []) x.p.overDays.forEach((d) => set.add(d))
    return [...set].sort((a, b) => a - b)
  }, [previews])
  const allMilestones = previews !== null && previews.every((x) => x.p.days.length === 0)

  // The chosen resource's weeks: what they carry now and what this adds (minus the assignment being replaced).
  const strip = useMemo(() => {
    if (!resourceId || !previews) return []
    const weekOf = (d: number) => isoOfDay(d - ((new Date(d * 86_400_000).getUTCDay() + 6) % 7))
    const weeks = bucketsFor(model, resourceId, 'week', window.from, window.to).slice(0, 8)
    const added = new Map<string, number>()
    const overWeeks = new Set<string>()
    for (const x of previews) {
      x.p.days.forEach((d, i) => {
        added.set(weekOf(d), (added.get(weekOf(d)) ?? 0) + x.p.hours[i])
      })
      x.p.overDays.forEach((d) => overWeeks.add(weekOf(d)))
    }
    const removed = new Map<string, number>()
    for (const t of chosen) {
      const ex = assignments.find((a) => a.sheetId === t.sheetId && a.rowId === t.rowId && a.resourceId === resourceId)
      const spread = ex && model.byResource.get(resourceId)?.spreads.find((s) => s.assignmentId === ex.id)
      spread?.days.forEach((d, i) => removed.set(weekOf(d), (removed.get(weekOf(d)) ?? 0) + spread.hours[i]))
    }
    return weeks.map((w) => ({ w, total: w.assigned - (removed.get(w.start) ?? 0) + (added.get(w.start) ?? 0), over: overWeeks.has(w.start) }))
  }, [model, resourceId, previews, window, chosen, assignments])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!resourceId || valueError || dateError) return
    setBusy(true)
    setError(null)
    setDone(null)
    let failed: string | null = null
    for (const t of chosen) {
      const r = await store.getState().assign({ sheetId: t.sheetId, rowId: t.rowId, resourceId, allocation, ...overrides })
      if (!r.ok) {
        failed = r.error
        break
      }
    }
    setBusy(false)
    if (failed) setError(failed)
    else {
      const name = resources.find((r) => r.id === resourceId)?.name ?? 'Resource'
      setDone(`${name} is assigned to ${chosen.length === 1 ? chosen[0].name : `${chosen.length} tasks`}.`)
      onDone()
    }
  }

  const existing = chosen.length === 1 && resourceId ? assignments.some((a) => a.sheetId === chosen[0].sheetId && a.rowId === chosen[0].rowId && a.resourceId === resourceId) : false

  return (
    <form className="asg-form asg-block" onSubmit={submit} noValidate aria-label="Assign a resource">
      <h3 className="res-h3">{existing ? 'Change allocation' : 'Assign a resource'}</h3>
      <Field label="Resource">
        {(id) => (
          <select id={id} value={resourceId} onChange={(e) => (setResourceId(e.currentTarget.value), setDone(null))}>
            <option value="">Choose…</option>
            {options.map(({ r, free }) => (
              <option key={r.id} value={r.id}>
                {r.name} — {fmtHours(free)} h free
              </option>
            ))}
          </select>
        )}
      </Field>
      <div className="asg-alloc">
        <Field label="Allocation">
          {(id) => (
            <select
              id={id}
              value={kind}
              onChange={(e) => {
                const k = e.currentTarget.value as AllocationKind
                setKind(k)
                setValue(DEFAULT_VALUE[k])
              }}
            >
              {(Object.keys(ALLOCATION_LABEL) as AllocationKind[]).map((k) => (
                <option key={k} value={k}>
                  {ALLOCATION_LABEL[k]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={kind === 'percent' ? 'Percent' : 'Hours'}>
          {(id) => <input id={id} inputMode="decimal" value={value} onChange={(e) => setValue(e.currentTarget.value)} aria-invalid={!!valueError} aria-describedby={valueError ? `${uid}-v` : undefined} />}
        </Field>
      </div>
      {valueError && (
        <p id={`${uid}-v`} role="alert" className="res-alert">
          {valueError}
        </p>
      )}
      <label className="asg-own">
        <input type="checkbox" checked={ownDates} onChange={(e) => setOwnDates(e.currentTarget.checked)} />
        Use dates of its own (do not follow the task)
      </label>
      {ownDates && (
        <div className="asg-alloc">
          <Field label="From">{(id) => <input id={id} type="date" value={start} onChange={(e) => setStart(e.currentTarget.value)} />}</Field>
          <Field label="To">{(id) => <input id={id} type="date" value={end} min={start} onChange={(e) => setEnd(e.currentTarget.value)} />}</Field>
        </div>
      )}
      {dateError && (
        <p role="alert" className="res-alert">
          {dateError}
        </p>
      )}

      {resourceId && previews && (
        <div className="asg-preview" aria-live="polite">
          {allMilestones ? (
            <p className="res-hint">There is no work to plan here: milestones take no time. Pick a task with a duration, or give the assignment dates of its own.</p>
          ) : (
            <>
              <p>
                Adds <strong>{fmtHours(totalHours)} h</strong> across {chosen.length === 1 ? 'this task' : `${chosen.length} tasks`}.
              </p>
              {overDays.length > 0 ? (
                <p role="status" className="res-warn asg-over">
                  <strong>Over-allocated:</strong> this puts {options.find((o) => o.r.id === resourceId)?.r.name} over capacity on {overDays.length} {overDays.length === 1 ? 'day' : 'days'} (
                  {overDays.slice(0, 3).map((d) => fmtDay(isoOfDay(d))).join(', ')}
                  {overDays.length > 3 ? ', …' : ''}). You can still assign; check the Leveling tab on the Resources page.
                </p>
              ) : (
                <p role="status" className="res-ok">
                  Within capacity.
                </p>
              )}
              {tasksLoading && <p className="res-hint">Still reading other sheets; the load shown may be incomplete.</p>}
              {strip.length > 0 && (
                <ul className="asg-strip" aria-label="Weekly load with this assignment">
                  {strip.map(({ w, total, over: dayOver }) => {
                    const over = dayOver || total > w.available + 1e-6
                    return (
                      <li key={w.start} data-level={over ? 'over' : total <= 1e-6 ? 'none' : total / (w.available || 1) < 0.5 ? 'low' : total / (w.available || 1) < 0.85 ? 'mid' : 'high'}>
                        <small>{fmtShort(w.start)}</small>
                        <strong>
                          {over && <span aria-hidden="true">! </span>}
                          {fmtHours(total)}/{fmtHours(w.available)}
                        </strong>
                        <span className="visually-hidden">
                          Week of {fmtDay(w.start)}: {fmtHours(total)} of {fmtHours(w.available)} hours with this assignment{over ? ', over-allocated' : ''}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="res-alert">
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="res-ok">
          {done}
        </p>
      )}
      <button type="submit" className="btn-primary" disabled={busy || !resourceId || !!valueError || !!dateError || allMilestones}>
        {busy ? 'Saving…' : existing ? 'Update assignment' : `Assign to ${chosen.length === 1 ? 'task' : `${chosen.length} tasks`}`}
      </button>
    </form>
  )
}
