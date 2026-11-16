import type { ComponentType } from 'react'
import type { IconName } from '../ui/Icon'
import { AutomationPage } from '../automation/AutomationPage'
import { DashboardsPage } from '../assets/DashboardsPage'
import { ReportsPage } from '../assets/ReportsPage'
import { ResourcesPage } from '../resources/ResourcesPage'
import { WorkspacesPage } from '../assets/WorkspacesPage'

/**
 * The top-level sections of the app, in navigation order. Each area is owned by its own folder
 * (assets, resources, automation): add a section here and give it a page component; nothing else in
 * the shell changes. `sheets` is rendered by the shell itself (the sheet list and the open sheet).
 */
export interface Section {
  id: string
  label: string
  icon: IconName
  /** Absent for `sheets`, which the shell renders. */
  Page?: ComponentType
}

export const SECTIONS: Section[] = [
  { id: 'sheets', label: 'Sheets', icon: 'sheet' },
  { id: 'workspaces', label: 'Workspaces', icon: 'folder', Page: WorkspacesPage },
  { id: 'reports', label: 'Reports', icon: 'list', Page: ReportsPage },
  { id: 'dashboards', label: 'Dashboards', icon: 'chart', Page: DashboardsPage },
  { id: 'resources', label: 'Resources', icon: 'users', Page: ResourcesPage },
  { id: 'automation', label: 'Automation', icon: 'bolt', Page: AutomationPage },
]
