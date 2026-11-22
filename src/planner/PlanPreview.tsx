import { useId, useState, type ReactNode, type RefObject } from 'react'
import { overview, type Entry } from './plannerEntries'
import { PIcon } from './PIcon'
import type { DurationBasis, PlanDraft } from './types'

export const BASIS_LABELS: Record<DurationBasis, string> = {
  p50: 'p50',
  p80: 'p80',
  default: 'Default',
  adjusted: 'Adjusted',
  file: 'From your file',
  template: 'Template',
  estimate: 'AI estimate',
  history: 'History',
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** "Drafted by AI from 9 historical projects" / "Built from history only — AI unavailable". */
export function sourceLabel(draft: PlanDraft): string {
  const n = draft.history.projectCount
  // The Data centre master never uses the AI: its durations are the template's and real long-lead history.
  if (draft.request.scheduleType === 'dc-master') return 'Built from the Data centre master template and past projects'
  if (draft.source === 'ai') return n > 0 ? `Drafted by AI from ${plural(n, 'historical project')}` : 'Drafted by AI (no historical projects)'
  return `Built from history only — AI unavailable${n > 0 ? ` (${plural(n, 'historical project')})` : ''}`
}

/** The equipment an entry is about, as the planner typed it: "Power transformer — 400 MVA transformer". */
export function entryTitle(entry: Entry): string {
  const { equipmentType: type, equipmentName: name } = entry.request
  return !name ? type : !type || name.toLowerCase().includes(type.toLowerCase()) ? name : `${type} — ${name}`
}

export const SAMPLE_WARNING = "Based on SAMPLE data, not your company's history."

/** One item's preview: feasibility banner, source, warnings, activities table, assumptions and risks. */
export function ItemPreview({ entry, showSampleWarning, noun = 'equipment', sevenDayWeek = false }: { entry: Entry; showSampleWarning: boolean; noun?: string; sevenDayWeek?: boolean }) {
  const tableTitleId = useId()
  const { draft, plan } = entry
  if (!draft || !plan) return null
  const { feasibility } = plan
  const target = plan.activities.find((a) => a.isTarget)
  const longest = Math.max(1, ...plan.activities.map((a) => a.durationDays))
  const critical = plan.activities.filter((a) => a.critical).length
  return (
    <div className="planner-item-preview">
      <div className={`planner-feasibility ${feasibility.feasible ? 'is-ok' : 'is-late'}`} role={feasibility.feasible ? 'status' : 'alert'}>
        <span className="planner-feasibility-icon">
          <PIcon name={feasibility.feasible ? 'checkCircle' : 'clockAlert'} size={22} />
        </span>
        <div className="planner-feasibility-body">
          <p className="planner-feasibility-title">
            {feasibility.feasible ? 'On time' : `Late by ${plural(feasibility.lateByWorkingDays, sevenDayWeek ? 'day' : 'working day')}`}
          </p>
          <p>{feasibility.message}</p>
          <p className="planner-feasibility-dates">
            Must start by <strong>{plan.mustStartBy}</strong> · {target?.name ?? 'Target'} on <strong>{plan.targetFinish}</strong>
          </p>
          {plan.dateNote && <p className="planner-date-note">{plan.dateNote}</p>}
        </div>
      </div>

      <div className="planner-source-row">
        <p className={`planner-source is-${draft.source}`}>
          <PIcon name={draft.source === 'ai' ? 'sparkles' : 'history'} size={15} />
          {sourceLabel(draft)}
        </p>
        {!showSampleWarning && draft.history.sampleOnly && (
          <span className="chip planner-chip is-sample">
            <PIcon name="alertCircle" size={13} />
            Sample data
          </span>
        )}
      </div>
      {draft.history.projectCount === 0 && draft.request.scheduleType !== 'dc-master' && (
        <p className="planner-sample" role="note">
          <PIcon name="alertCircle" size={18} />
          <span>
            <strong>No history for this {noun}; durations are defaults.</strong> {noun === 'development' ? 'Check them against your benchmarks and the consultants’ programme.' : 'Check them against vendor quotes.'}
          </span>
        </p>
      )}
      {showSampleWarning && draft.history.sampleOnly && (
        <p className="planner-sample" role="note">
          <PIcon name="alertCircle" size={18} />
          <span>
            <strong>{SAMPLE_WARNING}</strong> Check every duration before relying on this plan.
          </span>
        </p>
      )}
      <p className="planner-summary">{draft.summary}</p>

      <div className="planner-table-head">
        <p id={tableTitleId} className="planner-table-title">
          Activities ({plan.activities.length})
        </p>
        <p className="planner-table-meta">
          {critical > 0 ? `${critical} on the critical path · ` : ''}bars show duration in {sevenDayWeek ? 'days' : 'working days'}
        </p>
      </div>
      <div className="planner-table-wrap" tabIndex={0} role="region" aria-label={`Activities of ${entryTitle(entry)}, scrollable`}>
        <table className="planner-table" aria-labelledby={tableTitleId}>
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
            {plan.activities.map((a, i) => (
              <tr
                key={a.code}
                className={[a.critical ? 'is-critical' : '', i > 0 && plan.activities[i - 1].phase !== a.phase ? 'starts-phase' : ''].filter(Boolean).join(' ') || undefined}
              >
                <th scope="row">
                  {a.name}
                  {a.isTarget && <span className="planner-target"> (target)</span>}
                </th>
                <td className="planner-phase">{a.phase}</td>
                <td className="planner-duration">
                  {a.durationDays === 0 ? (
                    <span className="planner-milestone">Milestone</span>
                  ) : (
                    <>
                      <span className="planner-duration-text">{a.durationDays}d</span>
                      <span className="planner-duration-bar" aria-hidden="true">
                        <i style={{ width: `${Math.max(4, Math.round((a.durationDays / longest) * 100))}%` }} />
                      </span>
                    </>
                  )}
                </td>
                <td className="planner-basis-cell">
                  <span className={`chip planner-basis is-${a.basis}`}>{BASIS_LABELS[a.basis]}</span> <span className="planner-reason">{a.reason}</span>
                </td>
                <td className="planner-date">{a.start}</td>
                <td className="planner-date">{a.end}</td>
                <td className="planner-float">{a.critical ? <span className="chip planner-chip is-critical">Critical</span> : `${a.totalFloat}d float`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="planner-hint">
        Dates use a {sevenDayWeek ? '7-day' : 'Monday to Friday'} working week; you can change the calendar in the sheet's schedule settings.
      </p>

      {(draft.assumptions.length > 0 || draft.risks.length > 0) && (
        <div className="planner-lists">
          {draft.assumptions.length > 0 && (
            <section aria-label="Assumptions" className="planner-list is-assumptions">
              <h4>
                <PIcon name="info" size={16} />
                Assumptions
              </h4>
              <ul>
                {draft.assumptions.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </section>
          )}
          {draft.risks.length > 0 && (
            <section aria-label="Risks" className="planner-list is-risks">
              <h4>
                <PIcon name="alertCircle" size={16} />
                Risks
              </h4>
              <ul>
                {draft.risks.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  )
}

export interface PlanPreviewProps {
  entries: Entry[]
  headingRef: RefObject<HTMLHeadingElement>
  /** Instructions for a new draft of everything. */
  instruction: string
  instructionId: string
  onInstruction: (v: string) => void
  /** The form-level failure (with its Retry), if any. */
  failure: ReactNode
  creating: boolean
  /** What is being planned, lower case ('equipment'); used in the no-history note. */
  noun?: string
  onBack: () => void
  onRegenerateAll: () => void
  onRegenerateOne: (key: string, instruction: string) => void
  onRemove: (key: string) => void
  onCreate: () => void
  /** False for an imported plan: regenerating would redraft it from the catalog and lose the planner's activities. */
  allowRegenerate?: boolean
  /** The plan runs on a 7-day week (the Data centre master); the calendar hint says so. */
  sevenDayWeek?: boolean
}

/**
 * The preview step. One item: the single-item view (heading, banner, table). Several: an overall
 * summary on top, then one accordion card per item with its own feasibility banner, source and
 * table; a failed item shows its error with Retry (just that item) and Remove. The actions live in
 * a sticky footer so "Create schedule" is always in reach.
 */
export function PlanPreview(props: PlanPreviewProps) {
  const { entries, headingRef, instruction, instructionId, onInstruction, failure, creating, noun = 'equipment', onBack, onRegenerateAll, onRegenerateOne, onRemove, onCreate, allowRegenerate = true, sevenDayWeek = false } = props
  const many = entries.length > 1
  const info = overview(entries)
  const busy = creating || entries.some((e) => e.status === 'busy')
  const blocked = entries.some((e) => e.status !== 'ready')
  const [toggled, setToggled] = useState<Record<string, boolean>>({})
  const baseId = useId()

  const isOpen = (e: Entry, i: number) => toggled[e.key] ?? (i === 0 || e.status === 'failed')
  const onTime = entries.filter((e) => e.plan?.feasibility.feasible).length

  const heading = many ? `Draft plan: ${info.items} items` : `Draft plan: ${entries[0].request.equipmentName}`
  return (
    <div className="planner-step planner-preview">
      <div className="planner-body">
        <div className="planner-intro">
          <h3 ref={headingRef} tabIndex={-1}>
            {heading}
          </h3>
          <p>
            {!many && entries[0].request.scheduleType === 'dc-master'
              ? 'Review the plan built from the Data centre master template, then create the schedule.'
              : "Review the AI's first cut, adjust it with an instruction if needed, then create the schedule."}
          </p>
        </div>

        {many && (
          <section className="planner-overview card" aria-label="Plan overview">
            <div className="planner-overview-head">
              <span className="planner-overview-icon">
                <PIcon name="calendar" size={20} />
              </span>
              <p className="planner-overview-text">
                <strong>{info.text}</strong>
              </p>
            </div>
            <div className="planner-overview-chips">
              {onTime > 0 && (
                <span className="chip planner-chip is-ok">
                  <PIcon name="checkCircle" size={13} />
                  {onTime} on time
                </span>
              )}
              {info.late > 0 && (
                <span className="chip planner-chip is-late">
                  <PIcon name="clockAlert" size={13} />
                  {info.late} late
                </span>
              )}
              {info.sampleItems > 0 && (
                <span className="chip planner-chip is-sample">
                  <PIcon name="alertCircle" size={13} />
                  {info.sampleItems} using sample data
                </span>
              )}
              {info.failed > 0 && (
                <span className="chip planner-chip is-failed">
                  <PIcon name="alertCircle" size={13} />
                  {info.failed} failed
                </span>
              )}
            </div>
            {info.sampleItems > 0 && (
              <p className="planner-sample" role="note">
                <PIcon name="alertCircle" size={18} />
                <span>
                  <strong>{SAMPLE_WARNING}</strong>{' '}
                  {info.sampleItems === info.ready ? 'Every item uses it.' : `${plural(info.sampleItems, 'item')} use${info.sampleItems === 1 ? 's' : ''} it.`} Check every duration before relying on this plan.
                </span>
              </p>
            )}
          </section>
        )}

        {!many && entries[0].status === 'failed' && (
          <div className="planner-card card">
            <ItemBody entry={entries[0]} noun={noun} disabled={busy} removable={false} onRegenerate={onRegenerateOne} onRemove={onRemove} />
          </div>
        )}
        {!many && entries[0].status !== 'failed' && (
          <div className="planner-card card">
            <ItemPreview entry={entries[0]} showSampleWarning noun={noun} sevenDayWeek={sevenDayWeek} />
          </div>
        )}

        {many && (
          <div className="planner-accordion">
            {entries.map((entry, i) => {
              const open = isOpen(entry, i)
              const headerId = `${baseId}-h-${entry.key}`
              const panelId = `${baseId}-p-${entry.key}`
              return (
                <section key={entry.key} className={`planner-accordion-item card is-${entry.status}${open ? ' is-open' : ''}`}>
                  <h4 className="planner-accordion-heading">
                    <button
                      type="button"
                      id={headerId}
                      aria-expanded={open}
                      aria-controls={panelId}
                      className="planner-accordion-button"
                      onClick={() => setToggled((t) => ({ ...t, [entry.key]: !open }))}
                    >
                      <span className="planner-accordion-title">{entryTitle(entry)}</span>
                      <ItemChips entry={entry} />
                      <PIcon name="chevron" size={20} className="planner-accordion-chevron" />
                    </button>
                  </h4>
                  <div id={panelId} role="region" aria-labelledby={headerId} hidden={!open} className="planner-accordion-panel">
                    <ItemBody entry={entry} noun={noun} disabled={busy} removable={entries.length > 1} onRegenerate={onRegenerateOne} onRemove={onRemove} />
                  </div>
                </section>
              )
            })}
          </div>
        )}

        {many && entries.some((e) => e.status === 'failed') && (
          <p className="planner-hint">Retry or remove the items that failed before creating the schedule.</p>
        )}

        {allowRegenerate && (
          <div className="planner-card card planner-regenerate">
            <label htmlFor={instructionId} className="planner-label">
              {many ? 'Instructions for a new draft of all items (optional)' : 'Instructions for a new draft (optional)'}
            </label>
            <textarea
              id={instructionId}
              rows={2}
              value={instruction}
              onChange={(e) => onInstruction(e.target.value)}
              placeholder={noun === 'development' ? 'e.g. 40-storey tower: allow 7 working days per typical floor; authority approvals take 4 months' : 'e.g. Use p80 for fabrication; the vendor quotes 16 weeks'}
              disabled={busy}
            />
            <small>Not quite right? Describe what to change and use Regenerate; your other settings stay as they are.</small>
          </div>
        )}
      </div>

      {failure}
      <div className="planner-footer">
        {creating && (
          <p role="status" className="planner-footer-status">
            <span className="planner-spinner" aria-hidden="true" />
            Creating the schedule…
          </p>
        )}
        <button type="button" className="btn planner-back" onClick={onBack} disabled={busy}>
          <PIcon name="back" size={16} />
          Back
        </button>
        {allowRegenerate && (
          <button type="button" className="btn planner-regenerate-all" onClick={onRegenerateAll} disabled={busy}>
            <PIcon name="refresh" size={16} />
            {many ? 'Regenerate all' : 'Regenerate'}
          </button>
        )}
        <button type="button" className="btn btn-primary planner-approve" onClick={onCreate} disabled={busy || blocked}>
          <PIcon name="check" size={16} />
          Create schedule
        </button>
      </div>
    </div>
  )
}

/** Short status chips on an accordion header: on time / late / failed, source, sample data. */
function ItemChips({ entry }: { entry: Entry }) {
  if (entry.status === 'failed')
    return (
      <span className="planner-chips">
        <span className="chip planner-chip is-failed">
          <PIcon name="alertCircle" size={13} />
          Failed
        </span>
      </span>
    )
  if (entry.status === 'busy') return <span className="planner-chips"><span className="chip planner-chip">Drafting…</span></span>
  const { plan, draft } = entry
  if (!plan || !draft) return null
  return (
    <span className="planner-chips">
      {plan.feasibility.feasible ? (
        <span className="chip planner-chip is-ok">
          <PIcon name="checkCircle" size={13} />
          <span>
            On time · start by <span className="planner-nowrap">{plan.mustStartBy}</span>
          </span>
        </span>
      ) : (
        <span className="chip planner-chip is-late">
          <PIcon name="clockAlert" size={13} />
          <span>
            Late by {plural(plan.feasibility.lateByWorkingDays, 'working day')} · start was <span className="planner-nowrap">{plan.mustStartBy}</span>
          </span>
        </span>
      )}
      <span className={`chip planner-chip is-source-${draft.source}`}>
        <PIcon name={draft.source === 'ai' ? 'sparkles' : 'history'} size={13} />
        {draft.source === 'ai' ? 'AI draft' : 'History only'}
      </span>
      {draft.history.sampleOnly && (
        <span className="chip planner-chip is-sample">
          <PIcon name="alertCircle" size={13} />
          Sample data
        </span>
      )}
    </span>
  )
}

interface ItemBodyProps {
  noun: string
  entry: Entry
  disabled: boolean
  removable: boolean
  onRegenerate: (key: string, instruction: string) => void
  onRemove: (key: string) => void
}

/** The inside of one accordion card: the preview, or the failure with Retry, plus this item's own regeneration. */
function ItemBody({ entry, noun, disabled, removable, onRegenerate, onRemove }: ItemBodyProps) {
  const [instruction, setInstruction] = useState('')
  const id = useId()
  return (
    <>
      {entry.status === 'busy' && (
        <p role="status" className="planner-banner is-busy">
          <span className="planner-spinner" aria-hidden="true" />
          Drafting this item…
        </p>
      )}
      {entry.status === 'failed' && (
        <p role="alert" className="planner-banner is-danger">
          <PIcon name="alertCircle" size={18} />
          {entry.error ?? 'This item could not be drafted.'}
        </p>
      )}
      {entry.notice && (
        <p role="alert" className="planner-banner is-danger planner-notice">
          <PIcon name="alertCircle" size={18} />
          {entry.notice}
        </p>
      )}
      <ItemPreview entry={entry} showSampleWarning={false} noun={noun} />
      <div className="planner-refine">
        <div className="planner-field planner-regenerate-one">
          <label htmlFor={id} className="planner-label">
            Instructions for a new draft of this item (optional)
          </label>
          <textarea id={id} rows={2} value={instruction} onChange={(e) => setInstruction(e.target.value)} disabled={disabled} />
        </div>
        <div className="planner-item-actions">
          {entry.status === 'failed' ? (
            <button type="button" className="btn btn-sm" onClick={() => onRegenerate(entry.key, instruction)} disabled={disabled}>
              <PIcon name="refresh" size={15} />
              Retry
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                onRegenerate(entry.key, instruction)
                setInstruction('')
              }}
              disabled={disabled}
            >
              <PIcon name="refresh" size={15} />
              Regenerate this item
            </button>
          )}
          {removable && (
            <button type="button" className="btn btn-sm planner-remove-entry" onClick={() => onRemove(entry.key)} disabled={disabled}>
              <PIcon name="trash" size={15} />
              Remove from plan
            </button>
          )}
        </div>
      </div>
    </>
  )
}
