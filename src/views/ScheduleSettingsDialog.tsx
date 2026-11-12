import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { Calendar } from '../engine/types'
import { isAcceptedDate, MAX_DATE, MIN_DATE } from '../model/validate'
import { useSheetStore, useSheetStoreApi } from '../store/SheetStoreContext'
import { HOURS_PER_DAY_MSG, normalizeCalendar } from '../store/sheetSettings'
import './confirmDialog.css'
import './scheduleSettings.css'

/** Listed Monday first, as construction schedules are read; values are JS weekdays (0 = Sunday). */
const WEEKDAYS: readonly { value: number; label: string }[] = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
  { value: 0, label: 'Sunday' },
]

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** The sheet toolbar's "Schedule settings" button and the dialog it opens. */
export function ScheduleSettingsButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Schedule settings
      </button>
      {open && <ScheduleSettingsDialog onClose={() => setOpen(false)} />}
    </>
  )
}

type FieldError = { field: 'weekdays' | 'hours' | 'date' | 'form'; message: string }

/**
 * Modal editor for the sheet's working-day calendar and dependencies flag. Edits are local
 * until Save, which applies them through the store (validated there); errors show inline and
 * keep the dialog open. Focus starts inside, Tab cycles within, Escape cancels, and focus
 * returns to where it was on close.
 */
export function ScheduleSettingsDialog({ onClose }: { onClose: () => void }) {
  const api = useSheetStoreApi()
  const sheet = useSheetStore((s) => s.data?.sheet)
  const titleId = useId()
  const hoursId = useId()
  const dateId = useId()
  const errorId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)

  const [weekdays, setWeekdays] = useState<number[]>(() => sheet?.calendar.workingWeekdays ?? [])
  const [hours, setHours] = useState(() => String(sheet?.calendar.hoursPerDay ?? 8))
  const [dates, setDates] = useState<string[]>(() => [...(sheet?.calendar.nonWorkingDates ?? [])].sort())
  const [newDate, setNewDate] = useState('')
  const [depsOn, setDepsOn] = useState(() => sheet?.dependenciesEnabled ?? false)
  const [error, setError] = useState<FieldError | null>(null)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus()
    return () => {
      if (previous && previous.isConnected) previous.focus()
    }
  }, [])

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    e.stopPropagation() // keys inside the dialog never reach the grid or page behind it
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Tab') {
      const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      const inside = dialogRef.current?.contains(document.activeElement)
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  function toggleDay(day: number, on: boolean) {
    setWeekdays((cur) => (on ? [...cur.filter((d) => d !== day), day] : cur.filter((d) => d !== day)))
  }

  function addDate() {
    if (newDate === '') return setError({ field: 'date', message: 'Pick a date to add' })
    if (!isAcceptedDate(newDate)) {
      return setError({ field: 'date', message: `Enter a date between ${MIN_DATE} and ${MAX_DATE}` })
    }
    setError(null)
    setDates((cur) => (cur.includes(newDate) ? cur : [...cur, newDate].sort()))
    setNewDate('')
  }

  function save(e: FormEvent) {
    e.preventDefault()
    if (!sheet) return
    const cal: Calendar = { workingWeekdays: weekdays, nonWorkingDates: dates, hoursPerDay: hours.trim() === '' ? NaN : Number(hours) }
    // Validate the calendar before touching the store so a refused save changes nothing.
    const norm = normalizeCalendar(cal)
    if (!norm.ok) {
      const field = norm.error === HOURS_PER_DAY_MSG ? 'hours' : weekdays.length === 0 ? 'weekdays' : 'form'
      return setError({ field, message: norm.error })
    }
    const state = api.getState()
    if (depsOn !== sheet.dependenciesEnabled) {
      const r = state.setDependenciesEnabled(depsOn)
      if (!r.ok) return setError({ field: 'form', message: r.error })
    }
    const r = api.getState().setCalendar(norm.calendar)
    if (!r.ok) return setError({ field: 'form', message: r.error })
    onClose()
  }

  const errorFor = (field: FieldError['field']) => (error?.field === field ? error.message : null)
  const invalid = (field: FieldError['field']) => (error?.field === field ? { 'aria-invalid': true, 'aria-describedby': errorId } : {})

  return (
    <div className="confirm-backdrop">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="confirm-dialog schedule-settings" onKeyDown={onKeyDown}>
        <h2 id={titleId}>Schedule settings</h2>
        <form onSubmit={save} noValidate>
          <fieldset className="schedule-settings-days" {...invalid('weekdays')}>
            <legend>Working days</legend>
            {WEEKDAYS.map((d) => (
              <label key={d.value}>
                <input type="checkbox" checked={weekdays.includes(d.value)} onChange={(e) => toggleDay(d.value, e.target.checked)} />
                {d.label}
              </label>
            ))}
          </fieldset>

          <div className="schedule-settings-field">
            <label htmlFor={hoursId}>Hours per day</label>
            <input
              id={hoursId}
              type="number"
              min={1}
              max={24}
              step={0.5}
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              {...invalid('hours')}
            />
          </div>

          <fieldset className="schedule-settings-dates">
            <legend>Non-working dates</legend>
            {dates.length === 0 ? (
              <p className="schedule-settings-empty">No non-working dates</p>
            ) : (
              <ul aria-label="Non-working dates">
                {dates.map((d) => (
                  <li key={d}>
                    <span>{d}</span>
                    <button type="button" aria-label={`Remove ${d}`} onClick={() => setDates((cur) => cur.filter((x) => x !== d))}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="schedule-settings-add">
              <label htmlFor={dateId}>Non-working date</label>
              <input
                id={dateId}
                type="date"
                min={MIN_DATE}
                max={MAX_DATE}
                value={newDate}
                onChange={(e) => setNewDate(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addDate()
                  }
                }}
                {...invalid('date')}
              />
              <button type="button" onClick={addDate}>
                Add date
              </button>
            </div>
          </fieldset>

          <div className="schedule-settings-field">
            <label>
              <input type="checkbox" checked={depsOn} onChange={(e) => setDepsOn(e.target.checked)} />
              Dependencies drive dates
            </label>
            <p className="schedule-settings-hint">
              When off, predecessors are kept but no longer move Start dates.
            </p>
          </div>

          {error && (
            <p id={errorId} role="alert" className="schedule-settings-error">
              {errorFor(error.field)}
            </p>
          )}

          <div className="confirm-actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit">Save</button>
          </div>
        </form>
      </div>
    </div>
  )
}
