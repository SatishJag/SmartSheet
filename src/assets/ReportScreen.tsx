import { useState } from 'react'
import { useShell } from '../shell/ShellContext'
import { ReportBuilder } from './ReportBuilder'
import { ReportRunner } from './ReportRunner'
import { useSheetHub } from './sheetHub'
import { useAssets } from './useAssets'

interface Props {
  id: string
  /** Open the builder first (a new report). */
  startInEdit?: boolean
  onBack: () => void
  backLabel?: string
}

/** One report: its live view, and the builder behind Edit. They share one hub, so loaded sheets are reused. */
export function ReportScreen({ id, startInEdit = false, onBack, backLabel }: Props) {
  const { client, openSheet } = useShell()
  const hub = useSheetHub(client)
  const report = useAssets((s) => s.reports.find((r) => r.id === id))
  const status = useAssets((s) => s.status)
  const [editing, setEditing] = useState(startInEdit)

  if (!report) {
    return (
      <section className="asset-screen">
        <p className="asset-meta" role="status">
          {status === 'ready' ? 'This report no longer exists.' : 'Loading the report…'}
        </p>
        <button type="button" className="btn" onClick={onBack}>
          Back
        </button>
      </section>
    )
  }
  return editing ? (
    <ReportBuilder report={report} hub={hub} onDone={() => setEditing(false)} />
  ) : (
    <ReportRunner report={report} hub={hub} onBack={onBack} onEdit={() => setEditing(true)} onOpenSheet={openSheet} backLabel={backLabel} />
  )
}
