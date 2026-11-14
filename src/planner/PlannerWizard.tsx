import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Calendar } from '../engine/types'
import { isAcceptedDate, MAX_DATE, MIN_DATE } from '../model/validate'
import { projectScheduleTemplate } from '../templates'
import { planBackward, todayIso, type BackwardPlan } from './backward'
import { getAccessToken, getOptions, PlannerApiError, requestDraft } from './plannerApi'
import { insertSheetFromDraft } from './sheetFromDraft'
import type { DurationBasis, PlanDraft, PlannerOptions, PlanRequest } from './types'
import '../views/confirmDialog.css'
import './plannerWizard.css'

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
const OTHER = '__other__'

export interface PlannerWizardProps {
  client: SupabaseClient
  userId: string
  /** Called with the new sheet's id once the approved plan is saved. */
  onCreated: (sheetId: string) => void
  onClose: () => void
  /** Today's date (YYYY-MM-DD); defaults to the browser's. */
  today?: string
  /** The working calendar the plan and the new sheet use; defaults to the Project schedule template's. */
  calendar?: Calendar
}

type Step = 'request' | 'drafting' | 'preview' | 'creating'

interface Failure {
  message: string
  retry: (() => void) | null
}

const isAbort = (err: unknown) => err instanceof DOMException && err.name === 'AbortError'
const describe = (err: unknown, fallback: string) =>
  err instanceof PlannerApiError || err instanceof Error ? err.message : fallback

export const BASIS_LABELS: Record<DurationBasis, string> = {
  p50: 'p50',
  p80: 'p80',
  default: 'Default',
  adjusted: 'Adjusted',
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** "Drafted by AI from 9 historical projects" / "Built from history only — AI unavailable". */
export function sourceLabel(draft: PlanDraft): string {
  const n = draft.history.projectCount
  if (draft.source === 'ai') return n > 0 ? `Drafted by AI from ${plural(n, 'historical project')}` : 'Drafted by AI (no historical projects)'
  return `Built from history only — AI unavailable${n > 0 ? ` (${plural(n, 'historical project')})` : ''}`
}

/**
 * "Plan with AI": a modal wizard. Step 1 collects the request; the planning server drafts the
 * activities, durations and links; the client plans them backward from the required date and shows
 * a preview; "Create schedule" saves it as an ordinary sheet and opens it.
 *
 * Accessible like the other dialogs: labelled, focus moves inside on open and to each step's
 * heading as the step changes, Tab cycles within, Escape closes (except while saving), and focus
 * returns to the opener on close.
 */
export function PlannerWizard({ client, userId, onCreated, onClose, today: todayProp, calendar = projectScheduleTemplate.calendar }: PlannerWizardProps) {
  const [today] = useState(() => todayProp ?? todayIso())
  const ids = {
    title: useId(),
    type: useId(),
    equipment: useId(),
    otherEquipment: useId(),
    name: useId(),
    date: useId(),
    notes: useId(),
    instruction: useId(),
    error: useId(),
  }
  const dialogRef = useRef<HTMLDivElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const aborter = useRef<AbortController | null>(null)
  const mounted = useRef(true)

  const [options, setOptions] = useState<PlannerOptions | null>(null)
  const [optionsError, setOptionsError] = useState<string | null>(null)
  const [step, setStep] = useState<Step>('request')
  const [failure, setFailure] = useState<Failure | null>(null)
  const [fieldError, setFieldError] = useState<string | null>(null)

  const [scheduleType, setScheduleType] = useState('')
  const [equipmentChoice, setEquipmentChoice] = useState('')
  const [otherEquipment, setOtherEquipment] = useState('')
  const [equipmentName, setEquipmentName] = useState('')
  const [requiredDate, setRequiredDate] = useState('')
  const [notes, setNotes] = useState('')
  const [instruction, setInstruction] = useState('')

  const [lastRequest, setLastRequest] = useState<PlanRequest | null>(null)
  const [draft, setDraft] = useState<PlanDraft | null>(null)
  const [plan, setPlan] = useState<BackwardPlan | null>(null)

  /** A fresh AbortController for the next request; aborts the one before. */
  const nextSignal = () => {
    aborter.current?.abort()
    aborter.current = new AbortController()
    return aborter.current.signal
  }

  useEffect(() => {
    mounted.current = true
    const previous = document.activeElement as HTMLElement | null
    return () => {
      mounted.current = false
      aborter.current?.abort()
      if (previous && previous.isConnected) previous.focus()
    }
  }, [])

  const loadOptions = useCallback(async () => {
    setOptionsError(null)
    const signal = nextSignal()
    try {
      const loaded = await getOptions(await getAccessToken(client), { signal })
      if (!mounted.current || signal.aborted) return
      setOptions(loaded)
      const first = loaded.scheduleTypes[0]?.id ?? ''
      setScheduleType((cur) => cur || first)
    } catch (err) {
      if (isAbort(err) || !mounted.current) return
      setOptionsError(describe(err, 'Could not load the planner options'))
    }
  }, [client])

  useEffect(() => {
    void loadOptions()
  }, [loadOptions])

  const equipmentTypes = options?.equipmentTypes[scheduleType] ?? []
  // Default to the first equipment type with history whenever the schedule type or options change.
  useEffect(() => {
    setEquipmentChoice(equipmentTypes[0] ?? OTHER)
  }, [scheduleType, options])

  // Each step's heading takes focus, so keyboard and screen-reader users land on the new content.
  useEffect(() => {
    if (step === 'request' && !options) {
      dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus()
      return
    }
    headingRef.current?.focus()
  }, [step, options])

  const busy = step === 'drafting' || step === 'creating'

  function close() {
    if (step === 'creating') return
    aborter.current?.abort()
    onClose()
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    e.stopPropagation() // keys inside the dialog never reach the page behind it
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'Tab') {
      const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      const inside = dialogRef.current?.contains(document.activeElement)
      if (e.shiftKey && (document.activeElement === first || document.activeElement === headingRef.current || !inside)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  async function generate(request: PlanRequest, returnTo: 'request' | 'preview') {
    const signal = nextSignal()
    setFailure(null)
    setStep('drafting')
    setLastRequest(request)
    try {
      const token = await getAccessToken(client)
      const next = await requestDraft(token, request, { signal })
      if (!mounted.current || signal.aborted) return
      let planned: BackwardPlan
      try {
        planned = planBackward(next, calendar, today)
      } catch (err) {
        throw new Error(`The draft could not be scheduled: ${describe(err, 'invalid plan')}`)
      }
      setDraft(next)
      setPlan(planned)
      setInstruction('')
      setStep('preview')
    } catch (err) {
      if (isAbort(err) || !mounted.current) return
      setFailure({ message: describe(err, 'Could not draft the plan'), retry: () => void generate(request, returnTo) })
      setStep(returnTo === 'preview' && draft ? 'preview' : 'request')
    }
  }

  function submitRequest(e: FormEvent) {
    e.preventDefault()
    const equipmentType = (equipmentChoice === OTHER ? otherEquipment : equipmentChoice).trim()
    if (!scheduleType) return setFieldError('Choose a schedule type')
    if (!equipmentType) return setFieldError('Enter the equipment type')
    if (!equipmentName.trim()) return setFieldError('Enter the equipment name')
    if (!requiredDate) return setFieldError('Enter the date the equipment must be on site')
    if (!isAcceptedDate(requiredDate)) return setFieldError(`Enter a date between ${MIN_DATE} and ${MAX_DATE}`)
    setFieldError(null)
    const request: PlanRequest = {
      scheduleType,
      equipmentType,
      equipmentName: equipmentName.trim(),
      requiredDate,
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    }
    void generate(request, 'request')
  }

  function regenerate() {
    const base = lastRequest ?? draft?.request
    if (!base) return
    const extra = instruction.trim()
    const combined = [base.notes?.trim(), extra].filter(Boolean).join('\n')
    const { notes: _old, ...rest } = base
    void generate(combined ? { ...rest, notes: combined } : rest, 'preview')
  }

  async function create() {
    if (!draft) return
    setFailure(null)
    setStep('creating')
    try {
      const sheetId = await insertSheetFromDraft(client, draft, userId, calendar, { today })
      if (mounted.current) onCreated(sheetId)
    } catch (err) {
      if (!mounted.current) return
      setFailure({ message: `Could not create the schedule: ${describe(err, 'unknown error')}`, retry: () => void create() })
      setStep('preview')
    }
  }

  const failureBlock = failure && (
    <div className="planner-failure">
      <p role="alert" id={ids.error}>
        {failure.message}
      </p>
      {failure.retry && (
        <button type="button" onClick={failure.retry}>
          Retry
        </button>
      )}
    </div>
  )

  const knownProjects = draft?.history.projectCount
  return (
    <div className="confirm-backdrop">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ids.title}
        aria-busy={busy}
        className="confirm-dialog planner-wizard"
        onKeyDown={onKeyDown}
      >
        <div className="planner-titlebar">
          <h2 id={ids.title}>Plan with AI</h2>
          <button type="button" aria-label="Close" onClick={close} disabled={step === 'creating'}>
            ×
          </button>
        </div>

        {step === 'request' && (
          <form onSubmit={submitRequest} noValidate className="planner-request">
            <h3 ref={headingRef} tabIndex={-1}>
              What do you need on site?
            </h3>
            {!options && !optionsError && <p role="status">Loading planner options…</p>}
            {optionsError && (
              <div className="planner-failure">
                <p role="alert">{optionsError}</p>
                <button type="button" onClick={() => void loadOptions()}>
                  Retry
                </button>
              </div>
            )}
            {options && (
              <>
                <div className="planner-field">
                  <label htmlFor={ids.type}>Schedule type</label>
                  <select id={ids.type} value={scheduleType} onChange={(e) => setScheduleType(e.target.value)}>
                    {options.scheduleTypes.map((t) => (
                      <option key={t.id} value={t.id} title={t.description}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>
                {equipmentTypes.length > 0 ? (
                  <div className="planner-field">
                    <label htmlFor={ids.equipment}>Equipment type</label>
                    <select id={ids.equipment} value={equipmentChoice} onChange={(e) => setEquipmentChoice(e.target.value)}>
                      {equipmentTypes.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                      <option value={OTHER}>Other (type it)</option>
                    </select>
                  </div>
                ) : null}
                {(equipmentTypes.length === 0 || equipmentChoice === OTHER) && (
                  <div className="planner-field">
                    <label htmlFor={ids.otherEquipment}>{equipmentTypes.length === 0 ? 'Equipment type' : 'Other equipment type'}</label>
                    <input
                      id={ids.otherEquipment}
                      value={otherEquipment}
                      onChange={(e) => setOtherEquipment(e.target.value)}
                      placeholder="e.g. Gas turbine"
                    />
                    <small>No history for this type yet: the plan uses the schedule type's overall history.</small>
                  </div>
                )}
                <div className="planner-field">
                  <label htmlFor={ids.name}>Equipment name</label>
                  <input
                    id={ids.name}
                    value={equipmentName}
                    onChange={(e) => setEquipmentName(e.target.value)}
                    placeholder="e.g. 400 MVA transformer for substation B"
                    maxLength={200}
                  />
                </div>
                <div className="planner-field">
                  <label htmlFor={ids.date}>Required on site</label>
                  <input id={ids.date} type="date" min={MIN_DATE} max={MAX_DATE} value={requiredDate} onChange={(e) => setRequiredDate(e.target.value)} />
                </div>
                <div className="planner-field">
                  <label htmlFor={ids.notes}>Notes (optional)</label>
                  <textarea
                    id={ids.notes}
                    rows={3}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Vendor, region, constraints, be conservative…"
                  />
                </div>
                {fieldError && <p role="alert">{fieldError}</p>}
              </>
            )}
            {failureBlock}
            <div className="confirm-actions">
              <button type="button" onClick={close}>
                Cancel
              </button>
              <button type="submit" disabled={!options}>
                Generate
              </button>
            </div>
          </form>
        )}

        {step === 'drafting' && (
          <div className="planner-loading">
            <h3 ref={headingRef} tabIndex={-1}>
              Drafting your plan
            </h3>
            <p role="status">
              {knownProjects
                ? `Drafting from ${plural(knownProjects, 'historical project')}…`
                : 'Drafting from historical projects…'}
            </p>
            <div className="confirm-actions">
              <button type="button" onClick={close}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {(step === 'preview' || step === 'creating') && draft && plan && (
          <Preview
            draft={draft}
            plan={plan}
            headingRef={headingRef}
            instruction={instruction}
            instructionId={ids.instruction}
            onInstruction={setInstruction}
            failure={failureBlock}
            creating={step === 'creating'}
            onBack={() => {
              setFailure(null)
              setStep('request')
            }}
            onRegenerate={regenerate}
            onCreate={() => void create()}
          />
        )}
      </div>
    </div>
  )
}

interface PreviewProps {
  draft: PlanDraft
  plan: BackwardPlan
  headingRef: RefObject<HTMLHeadingElement>
  instruction: string
  instructionId: string
  onInstruction: (v: string) => void
  failure: ReactNode
  creating: boolean
  onBack: () => void
  onRegenerate: () => void
  onCreate: () => void
}

function Preview({ draft, plan, headingRef, instruction, instructionId, onInstruction, failure, creating, onBack, onRegenerate, onCreate }: PreviewProps) {
  const { feasibility } = plan
  const target = plan.activities.find((a) => a.isTarget)
  return (
    <div className="planner-preview">
      <h3 ref={headingRef} tabIndex={-1}>
        Draft plan: {draft.request.equipmentName}
      </h3>
      <p className={`planner-source is-${draft.source}`}>{sourceLabel(draft)}</p>
      {draft.history.projectCount === 0 && (
        <p className="planner-sample" role="note">
          <strong>No history for this equipment; durations are defaults.</strong> Check them against vendor quotes.
        </p>
      )}
      {draft.history.sampleOnly && (
        <p className="planner-sample" role="note">
          <strong>Based on SAMPLE data, not your company's history.</strong> Check every duration before relying on this plan.
        </p>
      )}
      <p className="planner-summary">{draft.summary}</p>

      <div className={`planner-feasibility ${feasibility.feasible ? 'is-ok' : 'is-late'}`} role={feasibility.feasible ? 'status' : 'alert'}>
        <p>{feasibility.message}</p>
        <p className="planner-feasibility-dates">
          Must start by <strong>{plan.mustStartBy}</strong> · {target?.name ?? 'Target'} on <strong>{plan.targetFinish}</strong>
        </p>
        {plan.dateNote && <p className="planner-date-note">{plan.dateNote}</p>}
      </div>

      <div className="planner-table-wrap">
        <table className="planner-table">
          <caption>Activities ({plan.activities.length})</caption>
          <thead>
            <tr>
              <th scope="col">Activity</th>
              <th scope="col">Phase</th>
              <th scope="col">Duration</th>
              <th scope="col">Basis</th>
              <th scope="col">Start</th>
              <th scope="col">End</th>
              <th scope="col">Float</th>
            </tr>
          </thead>
          <tbody>
            {plan.activities.map((a) => (
              <tr key={a.code} className={a.critical ? 'is-critical' : undefined}>
                <th scope="row">
                  {a.name}
                  {a.isTarget && <span className="planner-target"> (target)</span>}
                </th>
                <td>{a.phase}</td>
                <td>{a.durationDays === 0 ? 'Milestone' : `${a.durationDays}d`}</td>
                <td>
                  <span className={`planner-basis is-${a.basis}`}>{BASIS_LABELS[a.basis]}</span> <span className="planner-reason">{a.reason}</span>
                </td>
                <td>{a.start}</td>
                <td>{a.end}</td>
                <td>{a.critical ? 'Critical' : `${a.totalFloat}d float`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="planner-hint">Dates use a Monday to Friday working week; you can change the calendar in the sheet's schedule settings.</p>

      <div className="planner-lists">
        {draft.assumptions.length > 0 && (
          <section aria-label="Assumptions">
            <h4>Assumptions</h4>
            <ul>
              {draft.assumptions.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          </section>
        )}
        {draft.risks.length > 0 && (
          <section aria-label="Risks">
            <h4>Risks</h4>
            <ul>
              {draft.risks.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <div className="planner-field planner-regenerate">
        <label htmlFor={instructionId}>Instructions for a new draft (optional)</label>
        <textarea
          id={instructionId}
          rows={2}
          value={instruction}
          onChange={(e) => onInstruction(e.target.value)}
          placeholder="e.g. Use p80 for fabrication; the vendor quotes 16 weeks"
          disabled={creating}
        />
      </div>

      {failure}
      {creating && <p role="status">Creating the schedule…</p>}
      <div className="confirm-actions">
        <button type="button" onClick={onBack} disabled={creating}>
          Back
        </button>
        <button type="button" onClick={onRegenerate} disabled={creating}>
          Regenerate
        </button>
        <button type="button" className="planner-approve" onClick={onCreate} disabled={creating}>
          Create schedule
        </button>
      </div>
    </div>
  )
}
