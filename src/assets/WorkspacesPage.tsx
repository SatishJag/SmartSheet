import { useShell } from '../shell/ShellContext'

/** Workspaces. Placeholder: replaced by the workspaces work unit (see docs/superpowers/specs/2026-11-16-smartsheet-feature-gap.md). */
export function WorkspacesPage() {
  useShell()
  return (
    <div className="section-stub">
      <h1>Workspaces</h1>
      <p>Group sheets, reports and dashboards into shared folders. Coming soon.</p>
    </div>
  )
}
