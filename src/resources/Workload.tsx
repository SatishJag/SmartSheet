import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useShell } from '../shell/ShellContext'
import { Drawer } from './Drawer'
import {
  bucketsFor,
  contributions,
  dayNumber,
  isoOfDay,
  loadLevel,
  taskKey,
  utilizationOf,
  utilizationSummary,
  type Bucket,
  type BucketUnit,
  type Resource,
} from './engine'
import { BUCKET_COUNT, KIND_LABEL, bucketHeader, bucketLabel, fmtDay, fmtHours, fmtShort, pct, shiftAnchor, todayIso, windowFor } from './format'
import { loadModel } from './resourceStore'
import { useResourceStore } from './ResourceStoreContext'

export interface WorkloadView {
  unit: BucketUnit
  /** Any date inside the first visible column. */
  anchor: string
  department: string
  kind: string
  query: string
  sort: 'name' | 'load' | 'over'
  overOnly: boolean
}

export const DEFAULT_VIEW: WorkloadView = { unit: 'week', anchor: todayIso(), department: '', kind: '', query: '', sort: 'name', overOnly: false }

const ROW_H = 60

/** Filters a resource list by the view's department, type and search text. */
export function matchesView(r: Resource, v: Pick<WorkloadView, 'department' | 'kind' | 'query'>): boolean {
  if (v.department && (r.department ?? '') !== v.department) return false
  if (v.kind && r.kind !== v.kind) return false
  const q = v.query.trim().toLowerCase()
  if (q && !`${r.name} ${r.department ?? ''} ${r.skills.join(' ')}`.toLowerCase().includes(q)) return false
  return true
}

export function Workload({ view, onView }: { view: WorkloadView; onView: (v: WorkloadView) => void }) {
  const resources = useResourceStore((s) => s.resources)
  const model = useResourceStore(loadModel)
  const loaded = useResourceStore((s) => s.loaded)
  const tasksLoading = useResourceStore((s) => s.tasksLoading)
  const loadError = useResourceStore((s) => s.loadError)
  const filtersId = useId()
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [open, setOpen] = useState<{ resourceId: string; start: string; end: string; unit: BucketUnit } | null>(null)

  const win = useMemo(() => windowFor(view.unit, view.anchor, BUCKET_COUNT[view.unit]), [view.unit, view.anchor])
  const departments = useMemo(() => [...new Set(resources.map((r) => r.department).filter((d): d is string => !!d))].sort(), [resources])

  const visible = useMemo(() => {
    let list = resources.filter((r) => matchesView(r, view))
    const util = new Map(utilizationSummary(model, win.from, win.to, list.map((r) => r.id)).map((u) => [u.resourceId, u]))
    if (view.overOnly) list = list.filter((r) => (util.get(r.id)?.overDays ?? 0) > 0)
    if (view.sort === 'load') list = [...list].sort((a, b) => (util.get(b.id)?.utilization ?? -1) - (util.get(a.id)?.utilization ?? -1))
    if (view.sort === 'over') list = [...list].sort((a, b) => (util.get(b.id)?.excessHours ?? 0) - (util.get(a.id)?.excessHours ?? 0))
    return { list, util }
  }, [resources, model, view, win])

  const kpi = useMemo(() => {
    let assigned = 0
    let available = 0
    let over = 0
    for (const r of visible.list) {
      const u = visible.util.get(r.id)!
      assigned += u.assigned
      available += u.available
      if (u.overDays > 0) over++
    }
    return { assigned, available, over, free: Math.max(0, available - assigned) }
  }, [visible])

  const activeFilters = [view.department, view.kind, view.query.trim(), view.overOnly, view.sort !== 'name'].filter(Boolean).length
  const set = (patch: Partial<WorkloadView>) => onView({ ...view, ...patch })
  const setUnit = (unit: BucketUnit) => set({ unit, anchor: view.anchor })

  return (
    <section aria-label="Workload" className="res-section">
      <div className="res-toolbar">
        <div role="group" aria-label="Zoom" className="segmented segmented-sm">
          {(['day', 'week', 'month'] as const).map((u) => (
            <button key={u} type="button" aria-pressed={view.unit === u} onClick={() => setUnit(u)}>
              {u === 'day' ? 'Day' : u === 'week' ? 'Week' : 'Month'}
            </button>
          ))}
        </div>
        <div className="res-nav" role="group" aria-label="Date range">
          <button type="button" className="btn-sm" aria-label="Earlier" onClick={() => set({ anchor: shiftAnchor(view.unit, view.anchor, -Math.ceil(BUCKET_COUNT[view.unit] / 2)) })}>
            ‹
          </button>
          <button type="button" className="btn-sm" onClick={() => set({ anchor: todayIso() })}>
            Today
          </button>
          <button type="button" className="btn-sm" aria-label="Later" onClick={() => set({ anchor: shiftAnchor(view.unit, view.anchor, Math.ceil(BUCKET_COUNT[view.unit] / 2)) })}>
            ›
          </button>
          <input
            type="date"
            aria-label="Go to date"
            value={view.anchor}
            onChange={(e) => e.currentTarget.value && set({ anchor: e.currentTarget.value })}
          />
        </div>
        <button type="button" className="res-filters-toggle btn-sm" aria-expanded={filtersOpen} aria-controls={filtersId} onClick={() => setFiltersOpen((o) => !o)}>
          Filters{activeFilters > 0 ? ` (${activeFilters})` : ''}
        </button>
        <div id={filtersId} className={`res-filters${filtersOpen ? ' is-open' : ''}`}>
          <input type="search" aria-label="Search resources" placeholder="Search name, skill…" value={view.query} onChange={(e) => set({ query: e.currentTarget.value })} />
          <select aria-label="Department" value={view.department} onChange={(e) => set({ department: e.currentTarget.value })}>
            <option value="">All departments</option>
            {departments.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <select aria-label="Type" value={view.kind} onChange={(e) => set({ kind: e.currentTarget.value })}>
            <option value="">All types</option>
            {(['person', 'role', 'equipment'] as const).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
          <select aria-label="Sort" value={view.sort} onChange={(e) => set({ sort: e.currentTarget.value as WorkloadView['sort'] })}>
            <option value="name">Sort: name</option>
            <option value="load">Sort: most loaded</option>
            <option value="over">Sort: most over-allocated</option>
          </select>
          <label className="switch">
            <input type="checkbox" checked={view.overOnly} onChange={(e) => set({ overOnly: e.currentTarget.checked })} />
            <span className="switch-track" aria-hidden="true" />
            Over-allocated only
          </label>
        </div>
      </div>

      <dl className="res-kpis" aria-label="Utilisation summary">
        <div>
          <dt>Utilisation</dt>
          <dd>{kpi.available > 0 ? pct(kpi.assigned / kpi.available) : '–'}</dd>
          <small>
            {fmtHours(kpi.assigned)} of {fmtHours(kpi.available)} h
          </small>
        </div>
        <div className={kpi.over > 0 ? 'is-over' : undefined}>
          <dt>Over-allocated</dt>
          <dd>{kpi.over}</dd>
          <small>{kpi.over === 1 ? 'resource' : 'resources'} over capacity</small>
        </div>
        <div>
          <dt>Free capacity</dt>
          <dd>{fmtHours(kpi.free)} h</dd>
          <small>in this range</small>
        </div>
        <div>
          <dt>Resources</dt>
          <dd>{visible.list.length}</dd>
          <small>of {resources.length}</small>
        </div>
      </dl>

      {loadError && <p role="alert" className="res-alert">{loadError}</p>}
      {tasksLoading && (
        <p role="status" className="res-hint">
          Reading task dates from your sheets…
        </p>
      )}

      {!loaded ? (
        <div className="res-skeleton" aria-busy="true">
          <p className="visually-hidden">Loading resources…</p>
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} className="skeleton" style={{ width: `${96 - i * 6}%` }} />
          ))}
        </div>
      ) : resources.length === 0 ? (
        <div className="res-empty">
          <h3>No resources yet</h3>
          <p>Add the people, roles and equipment you plan work for on the Resources tab, then assign them to tasks from a project sheet.</p>
        </div>
      ) : visible.list.length === 0 ? (
        <div className="res-empty">
          <h3>No resource matches</h3>
          <p>Change the filters to see more.</p>
        </div>
      ) : (
        <>
          <div className="heat-meta">
            <Legend />
            <p className="res-hint">Numbers are assigned hours; shading is the share of capacity.</p>
          </div>
          <HeatMap
            resources={visible.list}
            util={visible.util}
            unit={view.unit}
            win={win}
            model={model}
            selected={open}
            onOpen={(resourceId, b) => setOpen({ resourceId, start: b.start, end: b.end, unit: view.unit })}
          />
        </>
      )}

      {open && <CellDetail open={open} onClose={() => setOpen(null)} />}
    </section>
  )
}

function Legend() {
  return (
    <ul className="heat-legend" aria-label="Legend">
      <li><span className="heat-swatch" data-level="none" />Free</li>
      <li><span className="heat-swatch" data-level="low" />Under 50%</li>
      <li><span className="heat-swatch" data-level="mid" />50 to 85%</li>
      <li><span className="heat-swatch" data-level="high" />85 to 100%</li>
      <li><span className="heat-swatch" data-level="over" />Over-allocated (!)</li>
    </ul>
  )
}

type Util = ReturnType<typeof utilizationOf>

function HeatMap({
  resources,
  util,
  unit,
  win,
  model,
  selected,
  onOpen,
}: {
  resources: Resource[]
  util: Map<string, Util>
  unit: BucketUnit
  win: { from: string; to: string; starts: string[] }
  model: ReturnType<typeof loadModel>
  selected: { resourceId: string; start: string } | null
  onOpen(resourceId: string, b: Bucket): void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState({ r: 0, c: 0 })
  const focusAfter = useRef(false)
  const virtualizer = useVirtualizer({ count: resources.length, getScrollElement: () => scrollRef.current, estimateSize: () => ROW_H, overscan: 6, initialRect: { width: 800, height: 600 } })
  const items = virtualizer.getVirtualItems()
  const cols = win.starts.length
  const r0 = Math.min(active.r, resources.length - 1)

  useEffect(() => {
    if (!focusAfter.current) return
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-r="${active.r}"][data-c="${active.c}"]`)
    if (el) {
      focusAfter.current = false
      el.focus()
    }
  })

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const d: Record<string, [number, number]> = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0] }
    let next = active
    if (d[e.key]) next = { r: Math.min(Math.max(active.r + d[e.key][0], 0), resources.length - 1), c: Math.min(Math.max(active.c + d[e.key][1], 0), cols - 1) }
    else if (e.key === 'Home') next = { r: active.r, c: 0 }
    else if (e.key === 'End') next = { r: active.r, c: cols - 1 }
    else return
    e.preventDefault()
    focusAfter.current = true
    virtualizer.scrollToIndex(next.r)
    setActive(next)
  }

  return (
    <div className="heat-scroll" ref={scrollRef} data-unit={unit}>
      <div role="grid" aria-label="Workload by resource" aria-rowcount={resources.length + 1} aria-colcount={cols + 1} className="heat" onKeyDown={onKeyDown}>
        <div role="row" aria-rowindex={1} className="heat-head">
          <div role="columnheader" className="heat-name heat-name-head" aria-colindex={1}>
            Resource
          </div>
          {win.starts.map((s, i) => {
            const h = bucketHeader(unit, s)
            const today = todayIso()
            const isNow = unit === 'day' ? s === today : unit === 'week' ? today >= s && today <= isoOfDay(dayNumber(s) + 6) : today.slice(0, 7) === s.slice(0, 7)
            return (
              <div key={s} role="columnheader" aria-colindex={i + 2} className={`heat-col${isNow ? ' is-now' : ''}`} title={unit === 'week' ? `Week of ${fmtDay(s)}` : fmtDay(s)}>
                <small>{h.top}</small>
                <strong>{h.bottom}</strong>
              </div>
            )
          })}
        </div>
        <div className="heat-body" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((item) => {
            const r = resources[item.index]
            const u = util.get(r.id)!
            const buckets = bucketsFor(model, r.id, unit, win.from, win.to)
            return (
              <div key={r.id} role="row" aria-rowindex={item.index + 2} className="heat-row" style={{ height: ROW_H, transform: `translateY(${item.start}px)` }}>
                <div role="rowheader" aria-colindex={1} className="heat-name">
                  <div className="heat-name-text">
                    <strong>{r.name}</strong>
                    <small>{[KIND_LABEL[r.kind], r.department].filter(Boolean).join(' · ')}</small>
                  </div>
                  <div className="heat-util" title={u.overDays > 0 ? `${u.overDays} over-allocated days in this range` : 'Utilisation in this range'}>
                    <span>{pct(u.utilization)}</span>
                    {u.overDays > 0 && <span className="badge-over">{u.overDays}d over</span>}
                  </div>
                </div>
                {buckets.map((b, c) => {
                  const isSel = selected?.resourceId === r.id && selected.start === b.start
                  return (
                    <div
                      key={b.start}
                      role="gridcell"
                      aria-colindex={c + 2}
                      data-r={item.index}
                      data-c={c}
                      data-level={b.over ? 'over' : b.level}
                      data-off={b.available === 0 && b.assigned === 0 ? '' : undefined}
                      className={`heat-cell${isSel ? ' is-selected' : ''}`}
                      tabIndex={item.index === r0 && c === active.c ? 0 : -1}
                      aria-label={bucketLabel(unit, b)}
                      title={bucketLabel(unit, b)}
                      onClick={() => {
                        setActive({ r: item.index, c })
                        onOpen(r.id, b)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          e.stopPropagation()
                          onOpen(r.id, b)
                        }
                      }}
                      onFocus={() => (active.r !== item.index || active.c !== c) && setActive({ r: item.index, c })}
                    >
                      {b.assigned > 0 && (
                        <span className="heat-val">
                          {b.over && <span aria-hidden="true" className="heat-flag">!</span>}
                          {fmtHours(b.assigned)}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function CellDetail({ open, onClose }: { open: { resourceId: string; start: string; end: string; unit: BucketUnit }; onClose: () => void }) {
  const { openSheet } = useShell()
  const model = useResourceStore(loadModel)
  const sheetNames = useResourceStore((s) => s.sheetNames)
  const resource = model.resources.get(open.resourceId)
  const u = utilizationOf(model, open.resourceId, open.start, open.end)
  const list = contributions(model, open.resourceId, open.start, open.end)
  const dayRows = useMemo(() => {
    if (open.unit === 'day') return []
    const out: { day: string; assigned: number; available: number }[] = []
    for (let d = dayNumber(open.start); d <= dayNumber(open.end); d++) {
      const x = utilizationOf(model, open.resourceId, isoOfDay(d), isoOfDay(d))
      if (x.available > 0 || x.assigned > 0) out.push({ day: isoOfDay(d), assigned: x.assigned, available: x.available })
    }
    return out
  }, [model, open])
  if (!resource) return null
  const range = open.start === open.end ? fmtDay(open.start) : `${fmtShort(open.start)} to ${fmtShort(open.end)}`
  const over = u.assigned > u.available || u.overDays > 0
  return (
    <Drawer title={resource.name} subtitle={range} onClose={onClose}>
      <p className={`res-detail-total${over ? ' is-over' : ''}`} role="status">
        <strong>
          {fmtHours(u.assigned)} of {fmtHours(u.available)} h
        </strong>
        <span>
          {pct(u.utilization)} utilised
          {u.overDays > 0 ? `, over-allocated on ${u.overDays} ${u.overDays === 1 ? 'day' : 'days'} (${fmtHours(u.excessHours)} h over)` : ''}
        </span>
      </p>

      {dayRows.length > 0 && (
        <ul className="res-days" aria-label="By day">
          {dayRows.map((d) => (
            <li key={d.day} data-level={loadLevel(d.assigned, d.available)}>
              <span>{fmtDay(d.day)}</span>
              <strong>
                {fmtHours(d.assigned)} of {fmtHours(d.available)} h
              </strong>
            </li>
          ))}
        </ul>
      )}

      <h3 className="res-h3">Tasks behind this number</h3>
      {list.length === 0 ? (
        <p className="res-hint">Nothing is assigned in this period.</p>
      ) : (
        <ul className="res-tasks">
          {list.map((c) => {
            const t = model.tasks.get(taskKey(c.sheetId, c.rowId))
            return (
              <li key={c.assignmentId}>
                <div>
                  <strong>{t?.name ?? 'Task'}</strong>
                  <small>
                    {sheetNames[c.sheetId] ?? 'Sheet'}
                    {t ? ` · ${fmtShort(t.start)} to ${fmtShort(t.end)}` : ''}
                  </small>
                </div>
                <span className="res-hours">{fmtHours(c.hours)} h</span>
                <button type="button" className="btn-sm" onClick={() => openSheet(c.sheetId)}>
                  Open sheet
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </Drawer>
  )
}
