import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Calendar } from '../engine/types'
import { MAX_DATE, MIN_DATE } from '../model/validate'
import { projectScheduleTemplate } from '../templates'
import { todayIso } from './backward'
import { Icon } from '../ui/Icon'
import { PlanPreview } from './PlanPreview'
import { equipmentGlyph, PIcon } from './PIcon'
import { getAccessToken, getOptions, PlannerApiError, requestBatch, requestDraft } from './plannerApi'
import {
  appendNote,
  batchRequestOf,
  planRequestOf,
  readyEntry,
  type Entry,
  type Job,
} from './plannerEntries'
import {
  addCardItem,
  effectiveDate,
  firstProblem,
  isPristine,
  jobFromForm,
  MAX_ITEMS,
  newItem,
  OTHER,
  removeCardItem,
  removeItem,
  setCostCode,
  syncCostCodes,
  validateItems,
  type FormValues,
  type ItemForm,
} from './plannerItems'
import { codeForType, costCodeOption, optionForCode } from './costCodes'
import { optionForProject, projectOption } from './procoreProjects'
import { insertSheetFromDrafts } from './sheetFromDraft'
import { DEFAULT_ITEM_LABELS, type CostCode, type ItemLabels, type PlannerOptions, type ProcoreProject } from './types'
import './plannerWizard.css'

export { BASIS_LABELS, sourceLabel } from './PlanPreview'

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

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

/** The schedule types offered under a project type: those that list it, or list none. */
function schedulesFor(options: PlannerOptions, projectType: string) {
  if (!projectType) return options.scheduleTypes
  return options.scheduleTypes.filter((t) => !t.projectTypes?.length || t.projectTypes.includes(projectType))
}

const Cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

const isAbort = (err: unknown) => err instanceof DOMException && err.name === 'AbortError'
const describe = (err: unknown, fallback: string) =>
  err instanceof PlannerApiError || err instanceof Error ? err.message : fallback

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * "Plan with AI": a modal wizard. Step 1 collects the request: a shared schedule type and notes and
 * one or more equipment items (ticked from the types with history, or added by hand), each with its
 * own required date. The planning server drafts every item's activities, durations and links; the
 * client plans each backward from its own date and shows a preview per item with an overall summary;
 * "Create schedule" saves ONE sheet (one summary row per item when there are several) and opens it.
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
    sharedDate: useId(),
    notes: useId(),
    project: useId(),
    procoreProject: useId(),
    instruction: useId(),
    error: useId(),
    item: useId(),
  }
  const dialogRef = useRef<HTMLDivElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const addButtonRef = useRef<HTMLButtonElement>(null)
  const aborter = useRef<AbortController | null>(null)
  const itemAborters = useRef(new Map<string, AbortController>())
  const focusAfterRender = useRef<string | null>(null)
  const mounted = useRef(true)

  const [options, setOptions] = useState<PlannerOptions | null>(null)
  const [optionsError, setOptionsError] = useState<string | null>(null)
  const [step, setStep] = useState<Step>('request')
  const [failure, setFailure] = useState<Failure | null>(null)
  const [submitted, setSubmitted] = useState(false)

  const [projectType, setProjectType] = useState('')
  const [scheduleType, setScheduleType] = useState('')
  /** The Procore project the plan is bought against (a code), or '' for none. Kept across type changes. */
  const [procoreProject, setProcoreProject] = useState('')
  const [items, setItems] = useState<ItemForm[]>(() => [newItem('')])
  const [sameDate, setSameDate] = useState(true)
  const [sharedDate, setSharedDate] = useState('')
  const [notes, setNotes] = useState('')
  const [instruction, setInstruction] = useState('')

  const [job, setJob] = useState<Job | null>(null)
  const [entries, setEntries] = useState<Entry[]>([])
  const [draftingCount, setDraftingCount] = useState(1)

  /** A fresh AbortController for the next request; aborts the one before. */
  const nextSignal = () => {
    aborter.current?.abort()
    aborter.current = new AbortController()
    return aborter.current.signal
  }

  const abortAll = () => {
    aborter.current?.abort()
    for (const c of itemAborters.current.values()) c.abort()
    itemAborters.current.clear()
  }

  useEffect(() => {
    mounted.current = true
    const previous = document.activeElement as HTMLElement | null
    const pending = itemAborters.current
    return () => {
      mounted.current = false
      aborter.current?.abort()
      for (const c of pending.values()) c.abort()
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
      const firstProject = loaded.projectTypes?.[0]?.id ?? ''
      setProjectType((cur) => cur || firstProject)
      const first = schedulesFor(loaded, firstProject)[0]?.id ?? ''
      setScheduleType((cur) => cur || first)
    } catch (err) {
      if (isAbort(err) || !mounted.current) return
      setOptionsError(describe(err, 'Could not load the planner options'))
    }
  }, [client])

  useEffect(() => {
    void loadOptions()
  }, [loadOptions])

  const visibleSchedules = options ? schedulesFor(options, projectType) : []
  const projectTypeName = options?.projectTypes?.find((t) => t.id === projectType)?.name
  const labels = { ...DEFAULT_ITEM_LABELS, ...options?.scheduleTypes.find((t) => t.id === scheduleType)?.itemLabels }
  const noun = labels.noun
  const Noun = Cap(noun)
  const equipmentTypes = options?.equipmentTypes[scheduleType] ?? []
  const projectCounts = options?.projectCounts?.[scheduleType] ?? {}
  const defaultChoice = equipmentTypes[0] ?? OTHER
  const costCodes = options?.costCodes ?? NO_COST_CODES
  const procoreProjects = options?.procoreProjects ?? NO_PROJECTS
  // Items whose type is not on offer for the schedule type (or not chosen yet) get the first type with history.
  useEffect(() => {
    if (!options) return
    setItems((prev) => {
      const next = prev.map((i) =>
        i.choice === OTHER || equipmentTypes.includes(i.choice) ? i : { ...i, choice: defaultChoice, fromCard: null },
      )
      return next.some((n, k) => n !== prev[k]) ? next : prev
    })
  }, [scheduleType, options])

  // Each item's cost code follows its type until the user picks or clears one (a no-op when nothing changes).
  useEffect(() => {
    if (costCodes.length === 0) return
    setItems((prev) => syncCostCodes(prev, (type) => codeForType(costCodes, type)))
  }, [items, costCodes])

  // Each step's heading takes focus, so keyboard and screen-reader users land on the new content.
  useEffect(() => {
    if (step === 'request' && !options) {
      dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus()
      return
    }
    headingRef.current?.focus()
  }, [step, options])

  // After adding or removing an item, focus moves to where the user is working.
  useEffect(() => {
    const target = focusAfterRender.current
    if (!target) return
    focusAfterRender.current = null
    if (target === 'add') addButtonRef.current?.focus()
    else document.getElementById(target)?.focus()
  }, [items])

  const busy = step === 'drafting' || step === 'creating'

  function close() {
    if (step === 'creating') return
    abortAll()
    onClose()
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    e.stopPropagation() // keys inside the dialog never reach the page behind it
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'Tab') {
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
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

  // ---- drafting ----

  /**
   * Drafts every item of the job and shows the preview. One item uses /draft exactly as before; several
   * use /draft-batch, where an item that fails stays in the preview with its own Retry. A failure of the
   * whole request returns to `returnTo` with the error and a Retry.
   */
  async function generate(next: Job, returnTo: 'request' | 'preview') {
    const signal = nextSignal()
    setFailure(null)
    setDraftingCount(next.items.length)
    setStep('drafting')
    try {
      const token = await getAccessToken(client)
      let drafted: Entry[]
      if (next.items.length === 1) {
        const item = next.items[0]
        const request = planRequestOf(next, item)
        const draft = await requestDraft(token, request, { signal })
        if (!mounted.current || signal.aborted) return
        drafted = [readyEntry(item.key, request, draft, calendar, today)]
      } else {
        const results = await requestBatch(token, batchRequestOf(next), { signal })
        if (!mounted.current || signal.aborted) return
        drafted = results.map((result, i): Entry => {
          const item = next.items[i]
          const request = planRequestOf(next, item)
          if (!result.ok) return { key: item.key, status: 'failed', request, error: result.error }
          try {
            return readyEntry(item.key, request, result.draft, calendar, today)
          } catch (err) {
            return { key: item.key, status: 'failed', request, error: describe(err, 'The draft could not be scheduled') }
          }
        })
        if (drafted.every((e) => e.status === 'failed')) {
          throw new Error(`None of the ${next.items.length} items could be drafted: ${drafted[0].error ?? 'unknown error'}`)
        }
      }
      setJob(next)
      setEntries(drafted)
      setInstruction('')
      setStep('preview')
    } catch (err) {
      if (isAbort(err) || !mounted.current) return
      setFailure({ message: describe(err, 'Could not draft the plan'), retry: () => void generate(next, returnTo) })
      setStep(returnTo === 'preview' && entries.length > 0 ? 'preview' : 'request')
    }
  }

  /** Drafts one item again (a Retry for a failed one, or new instructions for a good one); the others stay as they are. */
  async function regenerateOne(key: string, extra: string) {
    if (!job) return
    const item = job.items.find((i) => i.key === key)
    if (!item) return
    const note = extra.trim()
    const changed = note ? { ...item, notes: appendNote(item.notes, note) } : item
    const nextJob: Job = { ...job, items: job.items.map((i) => (i.key === key ? changed : i)) }
    const request = planRequestOf(nextJob, changed)
    itemAborters.current.get(key)?.abort()
    const controller = new AbortController()
    itemAborters.current.set(key, controller)
    const update = (change: (e: Entry) => Entry) => setEntries((all) => all.map((e) => (e.key === key ? change(e) : e)))
    setFailure(null)
    update((e) => ({ ...e, status: 'busy', error: undefined, notice: undefined }))
    try {
      const draft = await requestDraft(await getAccessToken(client), request, { signal: controller.signal })
      if (!mounted.current || controller.signal.aborted) return
      const entry = readyEntry(key, request, draft, calendar, today)
      setJob((j) => (j ? { ...j, items: j.items.map((i) => (i.key === key ? changed : i)) } : j))
      update(() => entry)
    } catch (err) {
      if (isAbort(err) || !mounted.current) return
      const message = describe(err, 'Could not draft this item')
      setJob((j) => (j ? { ...j, items: j.items.map((i) => (i.key === key ? changed : i)) } : j))
      // A good draft stays when its regeneration fails; a failed item stays failed.
      update((e) => (e.draft && e.plan ? { ...e, status: 'ready', notice: message } : { ...e, status: 'failed', error: message }))
    } finally {
      if (itemAborters.current.get(key) === controller) itemAborters.current.delete(key)
    }
  }

  function removeEntry(key: string) {
    setEntries((all) => (all.length > 1 ? all.filter((e) => e.key !== key) : all))
    setJob((j) => (j && j.items.length > 1 ? { ...j, items: j.items.filter((i) => i.key !== key) } : j))
  }

  function regenerateAll() {
    if (!job) return
    const extra = instruction.trim()
    void generate(extra ? { ...job, notes: appendNote(job.notes, extra) } : job, 'preview')
  }

  async function create() {
    const drafts = entries.flatMap((e) => (e.status === 'ready' && e.draft ? [e.draft] : []))
    if (drafts.length === 0 || drafts.length !== entries.length) return
    setFailure(null)
    setStep('creating')
    try {
      // Cost codes come from the form as it is now (they do not affect the plan), by item key.
      const sheetCostCodes =
        costCodes.length > 0
          ? {
              options: costCodes.map(costCodeOption),
              values: entries.map((e) => optionForCode(costCodes, items.find((i) => i.key === e.key)?.costCode ?? '')),
            }
          : undefined
      const project =
        procoreProjects.length > 0 ? { options: procoreProjects.map(projectOption), value: optionForProject(procoreProjects, procoreProject) } : undefined
      const sheetId = await insertSheetFromDrafts(client, drafts, userId, calendar, { today, costCodes: sheetCostCodes, project })
      if (mounted.current) onCreated(sheetId)
    } catch (err) {
      if (!mounted.current) return
      setFailure({ message: `Could not create the schedule: ${describe(err, 'unknown error')}`, retry: () => void create() })
      setStep('preview')
    }
  }

  // ---- the request form ----

  const form: FormValues = { scheduleType, items, sameDate, sharedDate, notes }
  const errors = validateItems(form, noun)
  const problem = firstProblem(form, errors)
  const many = items.length > 1
  const canAdd = items.length < MAX_ITEMS
  const roomForCard = canAdd || items.some(isPristine)

  function submitRequest(e: FormEvent) {
    e.preventDefault()
    setSubmitted(true)
    if (problem) return
    // The AI is told what kind of project this is, so a data centre and a building are not planned alike.
    const context = projectTypeName ? `Project type: ${projectTypeName}.` : ''
    void generate(jobFromForm(context ? { ...form, notes: appendNote(notes, context) ?? context } : form), 'request')
  }

  /** The schedule type follows the project type: it moves to the first one the new project type offers. */
  function chooseProjectType(id: string) {
    setProjectType(id)
    if (options) setScheduleType(schedulesFor(options, id)[0]?.id ?? '')
  }

  const updateItem = (key: string, patch: Partial<ItemForm>) => setItems((all) => all.map((i) => (i.key === key ? { ...i, ...patch } : i)))

  /**
   * Sets the item list, keeping the date the user entered once: the first item's date becomes the
   * shared date when a second item appears, and the shared date moves into the last item left.
   */
  function applyItems(next: ItemForm[]) {
    if (items.length === 1 && next.length > 1 && sameDate && !sharedDate && items[0].date) {
      setSharedDate(items[0].date)
      setItems(next.map((i) => (i.key === items[0].key ? { ...i, date: '' } : i)))
      return
    }
    if (next.length === 1 && items.length > 1 && sameDate && sharedDate && !next[0].date) {
      setItems([{ ...next[0], date: sharedDate }])
      return
    }
    setItems(next)
  }

  function toggleCard(type: string, on: boolean) {
    applyItems(on ? addCardItem(items, type) : removeCardItem(items, type, defaultChoice))
  }

  function addItem() {
    if (items.length >= MAX_ITEMS) return
    const item = newItem(defaultChoice)
    focusAfterRender.current = `${ids.item}-${item.key}-name`
    applyItems([...items, item])
  }

  function dropItem(key: string) {
    focusAfterRender.current = 'add'
    applyItems(removeItem(items, key, defaultChoice))
  }


  const failureBlock = failure && (
    <div className="planner-bar is-danger">
      <p role="alert" id={ids.error}>
        <PIcon name="alertCircle" size={18} />
        {failure.message}
      </p>
      {failure.retry && (
        <button type="button" className="btn btn-sm" onClick={failure.retry}>
          <PIcon name="refresh" size={15} />
          Retry
        </button>
      )}
    </div>
  )

  const knownProjects = entries.length === 1 ? entries[0].draft?.history.projectCount : undefined
  const stepNumber = step === 'preview' || step === 'creating' ? 2 : 1
  const scheduleDescription = options?.scheduleTypes.find((t) => t.id === scheduleType)?.description
  return (
    <div className="planner-backdrop">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ids.title}
        aria-busy={busy}
        className="planner-wizard"
        onKeyDown={onKeyDown}
      >
        <header className="planner-header">
          <span className="planner-header-icon">
            <Icon name="sparkles" size={22} />
          </span>
          <div className="planner-header-text">
            <h2 id={ids.title}>Plan with AI</h2>
            <p>An AI master planner drafts the first cut; you review and approve.</p>
          </div>
          <ol className="planner-steps" aria-label="Steps">
            <li aria-current={stepNumber === 1 ? 'step' : undefined} className={stepNumber === 1 ? 'is-current' : 'is-done'}>
              <span className="planner-step-num">{stepNumber === 2 ? <PIcon name="check" size={13} strokeWidth={3} /> : '1'}</span>
              Request
            </li>
            <li aria-current={stepNumber === 2 ? 'step' : undefined} className={stepNumber === 2 ? 'is-current' : undefined}>
              <span className="planner-step-num">2</span>
              Review plan
            </li>
          </ol>
          <button type="button" className="btn btn-icon planner-close" aria-label="Close" onClick={close} disabled={step === 'creating'}>
            <PIcon name="close" size={20} />
          </button>
        </header>

        {step === 'request' && (
          <form onSubmit={submitRequest} noValidate className="planner-step planner-request">
            <div className="planner-body">
              <div className="planner-intro">
                <h3 ref={headingRef} tabIndex={-1}>
                  {labels.heading ?? 'What do you need on site?'}
                </h3>
                <p>{labels.intro ?? `Choose the ${noun} and the date it must be on site. The plan is built backward from that date.`}</p>
              </div>
              {!options && !optionsError && (
                <div className="planner-card card" aria-hidden="true">
                  <span className="planner-skeleton" style={{ width: '30%', height: 14 }} />
                  <span className="planner-skeleton" style={{ width: '100%', height: 40, marginTop: 10 }} />
                  <span className="planner-skeleton" style={{ width: '100%', height: 72, marginTop: 14 }} />
                </div>
              )}
              {!options && !optionsError && (
                <p role="status" className="planner-hint">
                  Loading planner options…
                </p>
              )}
              {optionsError && (
                <div className="planner-bar is-danger planner-bar-inline">
                  <p role="alert">
                    <PIcon name="alertCircle" size={18} />
                    {optionsError}
                  </p>
                  <button type="button" className="btn btn-sm" onClick={() => void loadOptions()}>
                    <PIcon name="refresh" size={15} />
                    Retry
                  </button>
                </div>
              )}
              {options && (
                <>
                  <section className="planner-card card" aria-label={`Schedule and ${noun}`}>
                    {options.projectTypes && options.projectTypes.length > 0 && (
                      <div className="planner-field planner-project-type">
                        <label htmlFor={ids.project} className="planner-label">
                          Project type
                        </label>
                        <select id={ids.project} value={projectType} onChange={(e) => chooseProjectType(e.target.value)}>
                          {options.projectTypes.map((t) => (
                            <option key={t.id} value={t.id} title={t.description}>
                              {t.name}
                            </option>
                          ))}
                        </select>
                        <small>{options.projectTypes.find((t) => t.id === projectType)?.description}</small>
                      </div>
                    )}
                    <div className="planner-field planner-schedule-type">
                      <label htmlFor={ids.type} className="planner-label">
                        Schedule type
                      </label>
                      <select id={ids.type} value={scheduleType} onChange={(e) => setScheduleType(e.target.value)}>
                        {visibleSchedules.map((t) => (
                          <option key={t.id} value={t.id} title={t.description}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                      {scheduleDescription && <small>{scheduleDescription}</small>}
                    </div>
                    {procoreProjects.length > 0 && (
                      <div className="planner-field planner-schedule-type planner-procore-project">
                        <label htmlFor={ids.procoreProject} className="planner-label">
                          Procore project
                        </label>
                        <select id={ids.procoreProject} value={procoreProject} onChange={(e) => setProcoreProject(e.target.value)}>
                          <option value="">None</option>
                          {procoreProjects.map((p) => (
                            <option key={p.code} value={p.code}>
                              {projectOption(p)}
                            </option>
                          ))}
                        </select>
                        <small>The Procore project this plan is bought against: a program project for batch buying, or a site.</small>
                      </div>
                    )}

                    {equipmentTypes.length > 0 && (
                      <fieldset className="planner-types">
                        <legend>{Noun} with history</legend>
                        <p className="planner-hint">Tick what you need{labels.dateLabel ? '' : ' on site'}; each tick adds an item to the plan (up to {MAX_ITEMS}).</p>
                        <div className="planner-type-cards">
                          {equipmentTypes.map((type) => {
                            const checked = items.some((i) => i.fromCard === type)
                            const count = projectCounts[type]
                            const disabled = !checked && !roomForCard
                            return (
                              <label key={type} className={`planner-type-card${checked ? ' is-checked' : ''}${disabled ? ' is-disabled' : ''}`}>
                                <input
                                  type="checkbox"
                                  className="planner-tile-input"
                                  checked={checked}
                                  disabled={disabled}
                                  aria-label={count !== undefined ? `${type} · ${plural(count, 'project')}` : type}
                                  onChange={(e) => toggleCard(type, e.target.checked)}
                                />
                                <span className="planner-tile-icon">
                                  <PIcon name={equipmentGlyph(type)} size={20} />
                                </span>
                                <span className="planner-tile-text">
                                  <span className="planner-type-name">{type}</span>
                                  <span className="planner-type-count">{count !== undefined ? plural(count, 'project') : 'History available'}</span>
                                </span>
                                <span className="planner-tile-check">
                                  <PIcon name="check" size={13} strokeWidth={3} />
                                </span>
                              </label>
                            )
                          })}
                        </div>
                      </fieldset>
                    )}
                  </section>

                  <section className="planner-card card" aria-label="Items to plan">
                    <div className="planner-items-head">
                      <h4>
                        Items to plan <span className="planner-count">{items.length}</span>
                      </h4>
                      {many && (
                        <div className="planner-shared-date">
                          <label className="planner-switch">
                            <input type="checkbox" checked={sameDate} onChange={(e) => setSameDate(e.target.checked)} />
                            <span className="planner-switch-track" aria-hidden="true" />
                            Use the same date for all
                          </label>
                          {sameDate && (
                            <div className="planner-field planner-shared-field">
                              <label htmlFor={ids.sharedDate} className="planner-label">
                                {labels.dateLabel ?? 'Required on site'} (all items)
                              </label>
                              <input
                                id={ids.sharedDate}
                                type="date"
                                min={MIN_DATE}
                                max={MAX_DATE}
                                value={sharedDate}
                                onChange={(e) => setSharedDate(e.target.value)}
                              />
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    {many && sameDate && <p className="planner-hint">An item can have its own date instead: fill in its {labels.dateLabel ?? 'Required on site'} below.</p>}

                    <ol className="planner-items" aria-label={`${Noun} items`}>
                      {items.map((item, index) => (
                        <ItemFields
                          key={item.key}
                          item={item}
                          index={index}
                          idBase={`${ids.item}-${item.key}`}
                          many={many}
                          equipmentTypes={equipmentTypes}
                          labels={labels}
                          form={form}
                          errors={submitted ? errors[item.key] : undefined}
                          onChange={(patch) => updateItem(item.key, patch)}
                          costCodes={costCodes}
                          onCostCode={(code) => setItems((all) => all.map((i) => (i.key === item.key ? setCostCode(i, code) : i)))}
                          onRemove={() => dropItem(item.key)}
                        />
                      ))}
                    </ol>
                    <div className="planner-add">
                      <button type="button" className="btn btn-ghost planner-add-button" ref={addButtonRef} onClick={addItem} disabled={!canAdd}>
                        <PIcon name="plus" size={16} />
                        Add another item
                      </button>
                      {!canAdd && <small className="planner-hint"> You can plan up to {MAX_ITEMS} items at once.</small>}
                    </div>
                  </section>

                  <section className="planner-card card" aria-label="Notes">
                    <div className="planner-field">
                      <label htmlFor={ids.notes} className="planner-label">
                        {many ? 'Notes for all items (optional)' : 'Notes (optional)'}
                      </label>
                      <textarea
                        id={ids.notes}
                        rows={3}
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        placeholder="Vendor, region, constraints, be conservative…"
                      />
                    </div>
                  </section>
                  <p className="planner-footnote">
                    <PIcon name="info" size={15} />
                    Durations come from your completed projects. Without history, the planner uses the schedule type's catalog or clearly marked sample data.
                  </p>
                </>
              )}
            </div>
            {options && submitted && problem && (
              <div className="planner-bar is-danger">
                <p role="alert">
                  <PIcon name="alertCircle" size={18} />
                  {problem}
                </p>
              </div>
            )}
            {failureBlock}
            <div className="planner-footer">
              <button type="button" className="btn" onClick={close}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={!options}>
                <Icon name="sparkles" size={16} />
                Generate
              </button>
            </div>
          </form>
        )}

        {step === 'drafting' && (
          <div className="planner-step planner-loading">
            <div className="planner-body">
              <div className="planner-card card planner-loading-card">
                <span className="planner-loading-icon" aria-hidden="true">
                  <Icon name="sparkles" size={26} />
                </span>
                <h3 ref={headingRef} tabIndex={-1}>
                  {draftingCount > 1 ? 'Drafting your plans' : 'Drafting your plan'}
                </h3>
                <p role="status">
                  {draftingCount > 1
                    ? `Drafting ${draftingCount} items from historical projects; this can take a minute…`
                    : knownProjects
                      ? `Drafting from ${plural(knownProjects, 'historical project')}…`
                      : 'Drafting from historical projects…'}
                </p>
                <div className="planner-progress progress" aria-hidden="true">
                  <span />
                </div>
                <small className="planner-hint">The planner picks activities, durations and logic, then works backward from your date.</small>
              </div>
              <div className="planner-skeleton-stack" aria-hidden="true">
                {Array.from({ length: Math.min(draftingCount, 3) }, (_, i) => (
                  <div key={i} className="planner-card card planner-skeleton-card">
                    <span className="planner-skeleton" style={{ width: '38%', height: 16 }} />
                    <span className="planner-skeleton" style={{ width: '100%', height: 10 }} />
                    <span className="planner-skeleton" style={{ width: '82%', height: 10 }} />
                    <span className="planner-skeleton" style={{ width: '64%', height: 10 }} />
                  </div>
                ))}
              </div>
            </div>
            <div className="planner-footer">
              <button type="button" className="btn" onClick={close}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {(step === 'preview' || step === 'creating') && entries.length > 0 && (
          <PlanPreview
            entries={entries}
            headingRef={headingRef}
            instruction={instruction}
            instructionId={ids.instruction}
            onInstruction={setInstruction}
            failure={failureBlock}
            creating={step === 'creating'}
            noun={noun}
            onBack={() => {
              setFailure(null)
              setStep('request')
            }}
            onRegenerateAll={regenerateAll}
            onRegenerateOne={(key, extra) => void regenerateOne(key, extra)}
            onRemove={removeEntry}
            onCreate={() => void create()}
          />
        )}
      </div>
    </div>
  )
}

interface ItemFieldsProps {
  item: ItemForm
  index: number
  idBase: string
  many: boolean
  equipmentTypes: string[]
  labels: ItemLabels
  form: FormValues
  errors: { type?: string; name?: string; date?: string } | undefined
  onChange: (patch: Partial<ItemForm>) => void
  onRemove: () => void
  /** The Procore cost codes on offer; none: no Cost code field. */
  costCodes: readonly CostCode[]
  onCostCode: (code: string) => void
}

const NO_COST_CODES: CostCode[] = []
const NO_PROJECTS: ProcoreProject[] = []

const FieldError = ({ id, children }: { id: string; children: string }) => (
  <small id={id} className="planner-error">
    <PIcon name="alertCircle" size={14} />
    {children}
  </small>
)

/** One item of the request form (equipment, material, ...), as a compact row: type, name, its own required date (and Remove). */
function ItemFields({ item, index, idBase, many, equipmentTypes, labels, form, errors, onChange, onRemove, costCodes, onCostCode }: ItemFieldsProps) {
  const typeId = `${idBase}-type`
  const otherId = `${idBase}-other`
  const nameId = `${idBase}-name`
  const dateId = `${idBase}-date`
  const costCodeId = `${idBase}-cost-code`
  const hasCostCode = costCodes.length > 0
  const typeError = errors?.type
  const nameError = errors?.name
  const dateError = errors?.date
  const sharedDateInUse = many && form.sameDate
  const effective = effectiveDate(item, form)
  const showOther = equipmentTypes.length === 0 || item.choice === OTHER
  const hasSelect = equipmentTypes.length > 0
  const classes = ['planner-item-row', many ? 'has-index' : 'is-single', showOther ? 'has-other' : '', hasSelect ? '' : 'no-select', hasCostCode ? 'has-code' : ''].filter(Boolean).join(' ')
  const body = (
    <>
      {many && (
        <span className="planner-item-index" aria-hidden="true">
          {index + 1}
        </span>
      )}
      {hasSelect && (
        <div className="planner-field planner-f-type">
          <label htmlFor={typeId} className="planner-label">
            {Cap(labels.noun)} type
          </label>
          <select id={typeId} value={item.choice} onChange={(e) => onChange({ choice: e.target.value, fromCard: null })}>
            {equipmentTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
            <option value={OTHER}>Other (type it)</option>
          </select>
        </div>
      )}
      {showOther && (
        <div className="planner-field planner-f-other">
          <label htmlFor={otherId} className="planner-label">
            {equipmentTypes.length === 0 ? `${Cap(labels.noun)} type` : `Other ${labels.noun} type`}
          </label>
          <input
            id={otherId}
            value={item.other}
            onChange={(e) => onChange({ other: e.target.value })}
            placeholder={`e.g. ${labels.typeExample}`}
            maxLength={100}
            aria-invalid={typeError ? true : undefined}
            aria-describedby={typeError ? `${otherId}-error` : undefined}
          />
          <small>No history for this type yet: the plan uses the schedule type's overall history.</small>
          {typeError && <FieldError id={`${otherId}-error`}>{typeError}</FieldError>}
        </div>
      )}
      <div className="planner-field planner-f-name">
        <label htmlFor={nameId} className="planner-label">
          {Cap(labels.noun)} name
        </label>
        <input
          id={nameId}
          value={item.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder={`e.g. ${labels.nameExample}`}
          maxLength={200}
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? `${nameId}-error` : undefined}
        />
        {nameError && <FieldError id={`${nameId}-error`}>{nameError}</FieldError>}
      </div>
      <div className="planner-field planner-f-date">
        <label htmlFor={dateId} className="planner-label">
          {labels.dateLabel ?? 'Required on site'}
        </label>
        <input
          id={dateId}
          type="date"
          min={MIN_DATE}
          max={MAX_DATE}
          value={item.date}
          onChange={(e) => onChange({ date: e.target.value })}
          aria-invalid={dateError ? true : undefined}
          aria-describedby={dateError ? `${dateId}-error` : sharedDateInUse ? `${dateId}-hint` : undefined}
        />
        {sharedDateInUse && !item.date && (
          <small id={`${dateId}-hint`}>{effective ? `Uses the shared date, ${effective}.` : 'Empty: uses the shared date.'}</small>
        )}
        {dateError && <FieldError id={`${dateId}-error`}>{dateError}</FieldError>}
      </div>
      {hasCostCode && (
        <div className="planner-field planner-f-code">
          <label htmlFor={costCodeId} className="planner-label">
            Cost code
          </label>
          <select id={costCodeId} value={item.costCode} onChange={(e) => onCostCode(e.target.value)}>
            <option value="">None</option>
            {costCodes.map((c) => (
              <option key={c.code} value={c.code}>
                {costCodeOption(c)}
              </option>
            ))}
          </select>
        </div>
      )}
      {many && (
        <button
          type="button"
          className="btn btn-icon is-danger planner-remove"
          aria-label={`Remove item ${index + 1}`}
          title={`Remove item ${index + 1}`}
          onClick={onRemove}
        >
          <Icon name="trash" size={18} />
        </button>
      )}
    </>
  )
  if (!many)
    return (
      <li className="planner-item">
        <div className={classes}>{body}</div>
      </li>
    )
  return (
    <li className="planner-item">
      <fieldset className={classes}>
        <legend className="visually-hidden">{`Item ${index + 1}`}</legend>
        {body}
      </fieldset>
    </li>
  )
}
