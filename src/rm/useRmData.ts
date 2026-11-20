import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RmApi, RmData } from './api'
import type { AssignmentInput, PersonInput, ProjectInput, SavedView } from './types'

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

type WithId = { id: string }
const upsert = <T extends WithId>(list: T[], item: T) =>
  list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item]

/**
 * Loads all resource-management data once and keeps it in memory. Every action writes to the
 * backend first and updates local state only when the write succeeded, so the screen never shows
 * data the database refused. Actions resolve to an error message, or null on success.
 */
export function useRmData(api: RmApi) {
  const [data, setData] = useState<RmData | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const active = useRef(true)

  const reload = useCallback(async () => {
    try {
      const d = await api.loadAll()
      if (active.current) {
        setData(d)
        setLoadError(null)
      }
    } catch (err) {
      if (active.current) setLoadError(message(err))
    }
  }, [api])

  useEffect(() => {
    active.current = true
    void reload()
    return () => {
      active.current = false
    }
  }, [reload])

  const run = useCallback(async (op: () => Promise<(d: RmData) => RmData>): Promise<string | null> => {
    try {
      const apply = await op()
      if (active.current) setData((d) => (d ? apply(d) : d))
      return null
    } catch (err) {
      return message(err)
    }
  }, [])

  const actions = useMemo(
    () => ({
      reload,
      savePerson: (input: PersonInput, id?: string) =>
        run(async () => {
          const p = await api.savePerson(input, id)
          return (d) => ({ ...d, people: upsert(d.people, p) })
        }),
      deletePerson: (id: string) =>
        run(async () => {
          await api.deletePerson(id)
          // Mirrors the database cascades: assignments go, project ownership is cleared.
          return (d) => ({
            ...d,
            people: d.people.filter((p) => p.id !== id),
            assignments: d.assignments.filter((a) => a.person_id !== id),
            projects: d.projects.map((p) => (p.project_owner_id === id ? { ...p, project_owner_id: null } : p)),
          })
        }),
      saveProject: (input: ProjectInput, id?: string) =>
        run(async () => {
          const p = await api.saveProject(input, id)
          return (d) => ({ ...d, projects: upsert(d.projects, p) })
        }),
      /** Creates a project and resolves to its id (used when importing a sheet). */
      createProject: async (input: ProjectInput): Promise<{ error: string | null; id?: string }> => {
        try {
          const p = await api.saveProject(input)
          if (active.current) setData((d) => (d ? { ...d, projects: upsert(d.projects, p) } : d))
          return { error: null, id: p.id }
        } catch (err) {
          return { error: message(err) }
        }
      },
      deleteProject: (id: string) =>
        run(async () => {
          await api.deleteProject(id)
          return (d) => ({
            ...d,
            projects: d.projects.filter((p) => p.id !== id),
            assignments: d.assignments.filter((a) => a.project_id !== id),
          })
        }),
      saveAssignment: (input: AssignmentInput, id?: string) =>
        run(async () => {
          const a = await api.saveAssignment(input, id)
          return (d) => ({ ...d, assignments: upsert(d.assignments, a) })
        }),
      deleteAssignment: (id: string) =>
        run(async () => {
          await api.deleteAssignment(id)
          return (d) => ({ ...d, assignments: d.assignments.filter((a) => a.id !== id) })
        }),
      saveView: (view: Omit<SavedView, 'id' | 'created_at'>) =>
        run(async () => {
          const v = await api.saveView(view)
          return (d) => ({ ...d, views: upsert(d.views, v) })
        }),
      deleteView: (id: string) =>
        run(async () => {
          await api.deleteView(id)
          return (d) => ({ ...d, views: d.views.filter((v) => v.id !== id) })
        }),
    }),
    [api, reload, run],
  )

  return { data, loadError, actions }
}

export type RmActions = ReturnType<typeof useRmData>['actions']
