import { useMemo, useState } from 'react'
import { useShell } from '../shell/ShellContext'
import { Field } from './Field'
import { fmtDay, fmtShort, shiftAnchor, todayIso } from './format'
import { suggestLeveling, type LevelingResult } from './leveling'
import { allTasks } from './resourceStore'
import { useResourceStore } from './ResourceStoreContext'

/**
 * Leveling suggestions: tasks that could start later, inside their float, to remove an
 * over-allocation. Advisory only: nothing is changed; the user moves the task in its sheet.
 */
export function LevelingPanel() {
  const { openSheet } = useShell()
  const resources = useResourceStore((s) => s.resources)
  const assignments = useResourceStore((s) => s.assignments)
  const tasksById = useResourceStore((s) => s.tasks)
  const sheetNames = useResourceStore((s) => s.sheetNames)
  const loaded = useResourceStore((s) => s.loaded)
  const tasksLoading = useResourceStore((s) => s.tasksLoading)
  const [from, setFrom] = useState(() => todayIso())
  const [to, setTo] = useState(() => shiftAnchor('week', todayIso(), 13))
  const [result, setResult] = useState<LevelingResult | null>(null)
  const names = useMemo(() => new Map(resources.map((r) => [r.id, r.name])), [resources])
  const noFloat = useMemo(() => {
    const t = allTasks({ tasks: tasksById })
    return t.length > 0 && t.every((x) => x.totalFloat === null)
  }, [tasksById])

  const valid = from !== '' && to !== '' && to >= from

  function run() {
    setResult(suggestLeveling(resources, assignments, allTasks({ tasks: tasksById }), { from, to }))
  }

  return (
    <section aria-label="Leveling" className="res-section">
      <div className="res-explain card">
        <h2>Leveling suggestions</h2>
        <p>
          Lists tasks that can start later, within their float, to remove an over-allocation. Critical tasks are never moved, and nothing changes until you move the task in its sheet (for example by adding a lag to its
          predecessor or setting its start date).
        </p>
      </div>
      <form
        className="res-find"
        onSubmit={(e) => {
          e.preventDefault()
          if (valid) run()
        }}
      >
        <Field label="From">{(id) => <input id={id} type="date" value={from} onChange={(e) => setFrom(e.currentTarget.value)} />}</Field>
        <Field label="To">{(id) => <input id={id} type="date" value={to} min={from} onChange={(e) => setTo(e.currentTarget.value)} />}</Field>
        <button type="submit" className="btn-primary" disabled={!valid || !loaded || tasksLoading}>
          Find suggestions
        </button>
      </form>
      {noFloat && (
        <p className="res-hint" role="status">
          None of your sheets has dependencies switched on, so there is no float to level with. Turn dependencies on in Schedule settings.
        </p>
      )}
      {result && (
        <div aria-live="polite">
          {result.suggestions.length === 0 && result.unresolved.length === 0 ? (
            <div className="res-empty">
              <h3>No over-allocation</h3>
              <p>Nobody is over capacity between {fmtShort(from)} and {fmtShort(to)}.</p>
            </div>
          ) : (
            <>
              <h3 className="res-h3">
                {result.suggestions.length} {result.suggestions.length === 1 ? 'suggestion' : 'suggestions'}
              </h3>
              <ol className="res-suggest" aria-label="Suggestions">
                {result.suggestions.map((s) => (
                  <li key={`${s.sheetId}:${s.rowId}`} className="card">
                    <div>
                      <strong>
                        Delay “{s.taskName}” by {s.shiftDays} working {s.shiftDays === 1 ? 'day' : 'days'}
                      </strong>
                      <p>
                        {sheetNames[s.sheetId] ?? 'Sheet'}: move it to {fmtDay(s.newStart)} to {fmtDay(s.newEnd)}. That clears {names.get(s.resourceId) ?? 'a resource'}'s over-allocation on {s.clearedDays}{' '}
                        {s.clearedDays === 1 ? 'day' : 'days'}.
                      </p>
                      <p className={s.knockOn ? 'res-warn' : 'res-ok'}>
                        {s.knockOn ? 'Uses float shared with later tasks: successors move too, the project end does not.' : 'Inside its free float: no later task moves.'}
                      </p>
                    </div>
                    <button type="button" className="btn-sm" onClick={() => openSheet(s.sheetId)}>
                      Open sheet
                    </button>
                  </li>
                ))}
              </ol>
              {result.unresolved.length > 0 && (
                <>
                  <h3 className="res-h3">Still over-allocated</h3>
                  <ul className="res-unresolved">
                    {result.unresolved.map((u) => (
                      <li key={u.resourceId}>
                        <strong>{names.get(u.resourceId) ?? 'Resource'}</strong>: {u.overDays} {u.overDays === 1 ? 'day' : 'days'} over capacity with no task that can move. Reassign work, add capacity or extend the plan.
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {result.truncated && <p className="res-hint">The list was cut short; apply some of these and run it again.</p>}
            </>
          )}
        </div>
      )}
    </section>
  )
}
