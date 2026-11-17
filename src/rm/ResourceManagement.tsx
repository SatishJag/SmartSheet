import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllPages } from '../store/paging'
import { ConfirmDialog } from '../views/ConfirmDialog'
import { rmApi, type RmApi } from './api'
import { localToday } from './dates'
import { AssignmentDialog, PersonDialog, ProjectDialog } from './dialogs'
import { ImportSheetDialog } from './ImportSheetDialog'
import { MyWorkPage } from './MyWorkPage'
import { PeoplePage } from './PeoplePage'
import { ProjectsPage } from './ProjectsPage'
import { ReportsPage } from './ReportsPage'
import { SchedulePage } from './SchedulePage'
import { blankProject, fullName, type Assignment, type AssignmentInput, type Person, type Project } from './types'
import { useRmData } from './useRmData'
import './rm.css'

export type RmTab = 'mywork' | 'people' | 'schedule' | 'projects' | 'reports'

const TABS: { id: RmTab; label: string }[] = [
  { id: 'mywork', label: 'My Work' },
  { id: 'people', label: 'People' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'projects', label: 'Projects' },
  { id: 'reports', label: 'Reports' },
]

type Dialog =
  | { kind: 'person'; person: Person | null; initial?: Partial<Person> }
  | { kind: 'project'; project: Project | null }
  | { kind: 'assignment'; assignment: Assignment | null; initial: Partial<AssignmentInput> }
  | { kind: 'import' }
  | { kind: 'confirm'; title: string; message: string; run: () => Promise<string | null> }

export interface ResourceManagementProps {
  client: SupabaseClient
  email: string
  /** The signed-in user: projects may only link sheets they own (not sheets shared with them). */
  userId: string
  onOpenSheet: (sheetId: string) => void
  initialTab?: RmTab
  /** Overrides (tests). */
  api?: RmApi
  today?: string
}

export function ResourceManagement({ client, email, userId, onOpenSheet, initialTab = 'people', api: givenApi, today: givenToday }: ResourceManagementProps) {
  const api = useMemo(() => givenApi ?? rmApi(client), [givenApi, client])
  const today = givenToday ?? localToday()
  const { data, loadError, actions } = useRmData(api)
  const [tab, setTab] = useState<RmTab>(initialTab)
  const [search, setSearch] = useState('')
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [sheets, setSheets] = useState<{ id: string; name: string }[]>([])

  const loadSheets = useCallback(async () => {
    try {
      setSheets(
        (
          await fetchAllPages<{ id: string; name: string; owner_id: string }>((from, to) =>
            client.from('sheets').select('id,name,owner_id').order('name').order('id').range(from, to),
          )
        )
          .filter((s) => s.owner_id === userId)
          .map(({ id, name }) => ({ id, name })),
      )
    } catch {
      setSheets([]) // linking to sheets is optional; the rest of the page still works
    }
  }, [client, userId])
  useEffect(() => {
    void loadSheets()
  }, [loadSheets])
  const sheetNames = useMemo(() => new Map(sheets.map((s) => [s.id, s.name])), [sheets])

  if (loadError && !data) {
    return (
      <div className="rm-content">
        <p role="alert">Could not load resource management data: {loadError}</p>
        <button type="button" onClick={() => void actions.reload()}>
          Retry
        </button>
      </div>
    )
  }
  if (!data) return <p className="rm-content">Loading resource management...</p>

  const close = () => setDialog(null)
  const confirm = (title: string, message: string, run: () => Promise<string | null>) => setDialog({ kind: 'confirm', title, message, run })
  const editAssignment = (a: Assignment) => setDialog({ kind: 'assignment', assignment: a, initial: {} })
  const newAssignment = (initial: Partial<AssignmentInput>) => setDialog({ kind: 'assignment', assignment: null, initial })

  return (
    <div className="rm">
      <nav className="rm-nav" aria-label="Resource management">
        <div role="tablist" className="rm-tabs">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`rm-tab${tab === t.id ? ' is-active' : ''}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <span className="rm-spacer" />
        <button type="button" className="rm-link-button" onClick={() => setDialog({ kind: 'import' })}>
          + Add work from a sheet
        </button>
        <input type="search" className="rm-search" aria-label="Find in Resource Management" placeholder="Find in Resource Management..." value={search} onChange={(e) => setSearch(e.target.value)} />
      </nav>
      {notice && (
        <p className="rm-notice" role="status">
          {notice}{' '}
          <button type="button" className="rm-icon-button" aria-label="Dismiss" onClick={() => setNotice(null)}>
            ×
          </button>
        </p>
      )}

      <div role="tabpanel" className="rm-panel">
        {tab === 'mywork' && (
          <MyWorkPage
            data={data}
            email={email}
            today={today}
            onAddMe={() => setDialog({ kind: 'person', person: null, initial: { email, first_name: email.split('@')[0] } })}
            onEditAssignment={editAssignment}
          />
        )}
        {tab === 'people' && (
          <PeoplePage
            data={data}
            actions={actions}
            today={today}
            search={search}
            onAdd={() => setDialog({ kind: 'person', person: null })}
            onEdit={(p) => setDialog({ kind: 'person', person: p })}
          />
        )}
        {tab === 'schedule' && (
          <SchedulePage data={data} actions={actions} today={today} search={search} onNewAssignment={newAssignment} onEditAssignment={editAssignment} />
        )}
        {tab === 'projects' && (
          <ProjectsPage
            data={data}
            actions={actions}
            today={today}
            search={search}
            sheetNames={sheetNames}
            onAdd={() => setDialog({ kind: 'project', project: null })}
            onEdit={(p) => setDialog({ kind: 'project', project: p })}
            onOpenSheet={onOpenSheet}
          />
        )}
        {tab === 'reports' && <ReportsPage data={data} today={today} title="Resource Reports" />}
      </div>

      {dialog?.kind === 'person' && (
        <PersonDialog
          person={dialog.person}
          initialValues={dialog.initial}
          onClose={close}
          onSave={(input) => actions.savePerson(input, dialog.person?.id)}
          onDelete={
            dialog.person
              ? () => {
                  const p = dialog.person!
                  confirm('Delete person', `Delete ${fullName(p)} and all of their assignments? This cannot be undone.`, () => actions.deletePerson(p.id))
                }
              : undefined
          }
        />
      )}
      {dialog?.kind === 'project' && (
        <ProjectDialog
          project={dialog.project}
          initial={blankProject(today)}
          people={data.people}
          sheets={sheets}
          onClose={close}
          onSave={(input) => actions.saveProject(input, dialog.project?.id)}
          onDelete={
            dialog.project
              ? () => {
                  const p = dialog.project!
                  confirm('Delete project', `Delete "${p.name}" and all of its assignments? This cannot be undone.`, () => actions.deleteProject(p.id))
                }
              : undefined
          }
        />
      )}
      {dialog?.kind === 'assignment' && (
        <AssignmentDialog
          assignment={dialog.assignment}
          initial={dialog.initial}
          people={data.people}
          projects={data.projects.filter((p) => p.state === 'active' || p.id === dialog.assignment?.project_id)}
          onClose={close}
          onSave={(input) => actions.saveAssignment(input, dialog.assignment?.id)}
          onDelete={dialog.assignment ? () => void actions.deleteAssignment(dialog.assignment!.id).then((err) => (err ? setNotice(err) : close())) : undefined}
        />
      )}
      {dialog?.kind === 'import' && (
        <ImportSheetDialog
          client={client}
          sheets={sheets}
          people={data.people}
          projects={data.projects}
          today={today}
          saveProject={actions.createProject}
          saveAssignment={(input) => actions.saveAssignment(input)}
          onClose={close}
          onDone={(summary) => {
            setNotice(summary)
            setTab('projects')
          }}
        />
      )}
      {dialog?.kind === 'confirm' && (
        <ConfirmDialog
          title={dialog.title}
          message={dialog.message}
          confirmLabel="Delete"
          onCancel={close}
          onConfirm={() => {
            const run = dialog.run
            close()
            void run().then((err) => err && setNotice(err))
          }}
        />
      )}
    </div>
  )
}
