import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { useShell } from '../shell/ShellContext'
import { FindResource } from './FindResource'
import { LevelingPanel } from './LevelingPanel'
import { supabaseResourcePersistence } from './persistence'
import { createResourceStore } from './resourceStore'
import { ResourceList } from './ResourceList'
import { ResourceStoreProvider } from './ResourceStoreContext'
import { DEFAULT_VIEW, Workload, type WorkloadView } from './Workload'
import { todayIso } from './format'
import './resources.css'

type TabId = 'workload' | 'resources' | 'find' | 'leveling'

const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'workload', label: 'Workload' },
  { id: 'resources', label: 'Resources' },
  { id: 'find', label: 'Find a resource' },
  { id: 'leveling', label: 'Leveling' },
]

/**
 * Resources: who can be assigned, how loaded they are week by week, who is free, and what could move
 * to relieve an over-allocation. Assigning happens in a project sheet (the Resources panel there).
 */
export function ResourcesPage() {
  const { client } = useShell()
  const [store] = useState(() => createResourceStore(supabaseResourcePersistence(client)))
  useEffect(() => {
    void store.getState().loadAll()
  }, [store])
  return (
    <ResourceStoreProvider store={store}>
      <ResourcesBody />
    </ResourceStoreProvider>
  )
}

function ResourcesBody() {
  const [tab, setTab] = useState<TabId>('workload')
  const [view, setView] = useState<WorkloadView>(() => ({ ...DEFAULT_VIEW, anchor: todayIso() }))
  const baseId = useId()
  const refs = useRef(new Map<TabId, HTMLButtonElement>())

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const i = TABS.findIndex((t) => t.id === tab)
    const n = TABS.length
    const next = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1
    if (next < 0) return
    e.preventDefault()
    setTab(TABS[next].id)
    refs.current.get(TABS[next].id)?.focus()
  }

  return (
    <div className="res-page">
      <header className="res-head">
        <div>
          <h1>Resources</h1>
          <p>Who is assigned to what, how loaded they are, and who is free.</p>
        </div>
      </header>
      <div role="tablist" aria-label="Resources views" className="segmented res-tabs" onKeyDown={onKeyDown}>
        {TABS.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              if (el) refs.current.set(t.id, el)
              else refs.current.delete(t.id)
            }}
            type="button"
            role="tab"
            id={`${baseId}-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`${baseId}-panel`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-tab-${tab}`} className="res-panel">
        {tab === 'workload' && <Workload view={view} onView={setView} />}
        {tab === 'resources' && <ResourceList />}
        {tab === 'find' && (
          <FindResource
            onShowWorkload={(name, from) => {
              setView((v) => ({ ...v, query: name, anchor: from }))
              setTab('workload')
            }}
          />
        )}
        {tab === 'leveling' && <LevelingPanel />}
      </div>
    </div>
  )
}
