import { useShell } from '../shell/ShellContext'

/** Reports. Placeholder: replaced by the reports work unit (see docs/superpowers/specs/2026-11-16-smartsheet-feature-gap.md). */
export function ReportsPage() {
  useShell()
  return (
    <div className="section-stub">
      <h1>Reports</h1>
      <p>Pull rows from many sheets into one live, filterable report. Coming soon.</p>
    </div>
  )
}
