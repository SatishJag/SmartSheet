import { useShell } from '../shell/ShellContext'
import { ResourceManagement } from './ResourceManagement'

/**
 * "People & projects": portfolio resource management (people booked to projects over time, budgets,
 * reports, My Work) as a section of the app shell. Task-level resources (workload and leveling on a
 * sheet's tasks) are the separate "Resources" section.
 */
export function PeopleProjectsPage() {
  const { client, userId, email, openSheet } = useShell()
  return <ResourceManagement client={client} email={email} userId={userId} onOpenSheet={openSheet} />
}
