import { useId, useState, type ReactNode, type RefObject } from 'react'
import { overview, type Entry } from './plannerEntries'
import type { DurationBasis, PlanDraft } from './types'

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

/** The equipment an entry is about, as the planner typed it: "Power transformer — 400 MVA transformer". */
export function entryTitle(entry: Entry): string {
  const { equipmentType: type, equipmentName: name } = entry.request
  return !name ? type : !type || name.toLowerCase().includes(type.toLowerCase()) ? name : `${type} — ${name}`
}

export const SAMPLE_WARNING = "Based on SAMPLE data, not your company's history."

/** One item's preview: source, warnings, feasibility banner and activities table, assumptions and risks. */
export function ItemPreview({ entry, showSampleWarning }: { entry: Entry; showSampleWarning: boolean }) {
  const { draft, plan } = entry
  if (!draft || !plan) return null
  const { feasibility } = plan
  const target = plan.activities.find((a) => a.isTarget)
  return (
    <div className="planner-item-preview">
      <p className={`planner-source is-${draft.source}`}>{sourceLabel(draft)}</p>
      {draft.history.projectCount === 0 && (
        <p className="planner-sample" role="note">
          <strong>No history for this equipment; durations are defaults.</strong> Check them against vendor quotes.
        </p>
      )}
      {showSampleWarning && draft.history.sampleOnly && (
        <p className="planner-sample" role="note">
          <strong>{SAMPLE_WARNING}</strong> Check every duration before relying on this plan.
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
  onBack: () => void
  onRegenerateAll: () => void
  onRegenerateOne: (key: string, instruction: string) => void
  onRemove: (key: string) => void
  onCreate: () => void
}

/**
 * The preview step. One item: the single-item view (heading, banner, table). Several: an overall
 * summary on top, then one accordion section per item with its own feasibility banner, source and
 * table; a failed item shows its error with Retry (just that item) and Remove.
 */
export function PlanPreview(props: PlanPreviewProps) {
  const { entries, headingRef, instruction, instructionId, onInstruction, failure, creating, onBack, onRegenerateAll, onRegenerateOne, onRemove, onCreate } = props
  const many = entries.length > 1
  const info = overview(entries)
  const busy = creating || entries.some((e) => e.status === 'busy')
  const blocked = entries.some((e) => e.status !== 'ready')
  const [toggled, setToggled] = useState<Record<string, boolean>>({})
  const baseId = useId()

  const isOpen = (e: Entry, i: number) => toggled[e.key] ?? (i === 0 || e.status === 'failed')

  const heading = many ? `Draft plan: ${info.items} items` : `Draft plan: ${entries[0].request.equipmentName}`
  return (
    <div className="planner-preview">
      <h3 ref={headingRef} tabIndex={-1}>
        {heading}
      </h3>

      {many && (
        <div className="planner-overview">
          <p className="planner-overview-text">
            <strong>{info.text}</strong>
          </p>
          {info.sampleItems > 0 && (
            <p className="planner-sample" role="note">
              <strong>{SAMPLE_WARNING}</strong>{' '}
              {info.sampleItems === info.ready ? 'Every item uses it.' : `${plural(info.sampleItems, 'item')} use${info.sampleItems === 1 ? 's' : ''} it.`} Check every duration before relying on this plan.
            </p>
          )}
        </div>
      )}

      {!many && entries[0].status === 'failed' && (
        <ItemBody entry={entries[0]} disabled={busy} removable={false} onRegenerate={onRegenerateOne} onRemove={onRemove} />
      )}
      {!many && entries[0].status !== 'failed' && <ItemPreview entry={entries[0]} showSampleWarning />}

      {many && (
        <div className="planner-accordion">
          {entries.map((entry, i) => {
            const open = isOpen(entry, i)
            const headerId = `${baseId}-h-${entry.key}`
            const panelId = `${baseId}-p-${entry.key}`
            return (
              <section key={entry.key} className={`planner-accordion-item is-${entry.status}`}>
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
                  </button>
                </h4>
                <div id={panelId} role="region" aria-labelledby={headerId} hidden={!open} className="planner-accordion-panel">
                  <ItemBody
                    entry={entry}
                    disabled={busy}
                    removable={entries.length > 1}
                    onRegenerate={onRegenerateOne}
                    onRemove={onRemove}
                  />
                </div>
              </section>
            )
          })}
        </div>
      )}

      {many && entries.some((e) => e.status === 'failed') && (
        <p className="planner-hint">Retry or remove the items that failed before creating the schedule.</p>
      )}

      <div className="planner-field planner-regenerate">
        <label htmlFor={instructionId}>{many ? 'Instructions for a new draft of all items (optional)' : 'Instructions for a new draft (optional)'}</label>
        <textarea
          id={instructionId}
          rows={2}
          value={instruction}
          onChange={(e) => onInstruction(e.target.value)}
          placeholder="e.g. Use p80 for fabrication; the vendor quotes 16 weeks"
          disabled={busy}
        />
      </div>

      {failure}
      {creating && <p role="status">Creating the schedule…</p>}
      <div className="confirm-actions">
        <button type="button" onClick={onBack} disabled={busy}>
          Back
        </button>
        <button type="button" onClick={onRegenerateAll} disabled={busy}>
          {many ? 'Regenerate all' : 'Regenerate'}
        </button>
        <button type="button" className="planner-approve" onClick={onCreate} disabled={busy || blocked}>
          Create schedule
        </button>
      </div>
    </div>
  )
}

/** Short status chips on an accordion header: on time / late / failed, source, sample data. */
function ItemChips({ entry }: { entry: Entry }) {
  if (entry.status === 'failed') return <span className="planner-chip is-failed">Failed</span>
  if (entry.status === 'busy') return <span className="planner-chip">Drafting…</span>
  const { plan, draft } = entry
  if (!plan || !draft) return null
  return (
    <span className="planner-chips">
      {plan.feasibility.feasible ? (
        <span className="planner-chip is-ok">On time · start by {plan.mustStartBy}</span>
      ) : (
        <span className="planner-chip is-late">
          Late by {plural(plan.feasibility.lateByWorkingDays, 'working day')} · start was {plan.mustStartBy}
        </span>
      )}
      <span className={`planner-chip is-source-${draft.source}`}>{draft.source === 'ai' ? 'AI draft' : 'History only'}</span>
      {draft.history.sampleOnly && <span className="planner-chip is-sample">Sample data</span>}
    </span>
  )
}

interface ItemBodyProps {
  entry: Entry
  disabled: boolean
  removable: boolean
  onRegenerate: (key: string, instruction: string) => void
  onRemove: (key: string) => void
}

/** The inside of one accordion section: the preview, or the failure with Retry, plus this item's own regeneration. */
function ItemBody({ entry, disabled, removable, onRegenerate, onRemove }: ItemBodyProps) {
  const [instruction, setInstruction] = useState('')
  const id = useId()
  return (
    <>
      {entry.status === 'busy' && <p role="status">Drafting this item…</p>}
      {entry.status === 'failed' && (
        <div className="planner-failure">
          <p role="alert">{entry.error ?? 'This item could not be drafted.'}</p>
        </div>
      )}
      {entry.notice && (
        <p role="alert" className="planner-notice">
          {entry.notice}
        </p>
      )}
      <ItemPreview entry={entry} showSampleWarning={false} />
      <div className="planner-field planner-regenerate-one">
        <label htmlFor={id}>Instructions for a new draft of this item (optional)</label>
        <textarea
          id={id}
          rows={2}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          disabled={disabled}
        />
      </div>
      <div className="planner-item-actions">
        {entry.status === 'failed' ? (
          <button type="button" onClick={() => onRegenerate(entry.key, instruction)} disabled={disabled}>
            Retry
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              onRegenerate(entry.key, instruction)
              setInstruction('')
            }}
            disabled={disabled}
          >
            Regenerate this item
          </button>
        )}
        {removable && (
          <button type="button" onClick={() => onRemove(entry.key)} disabled={disabled}>
            Remove from plan
          </button>
        )}
      </div>
    </>
  )
}
