import { useCallback, useState, type ReactNode } from 'react'
import { useShell } from '../shell/ShellContext'
import './assets.css'
import { DashboardScreen } from './DashboardScreen'
import { pushRecent } from './recent'
import { ReportScreen } from './ReportScreen'
import type { AssetType } from './types'

interface View {
  type: 'report' | 'dashboard'
  id: string
  edit: boolean
}

/**
 * Opens assets from any of the three pages. A sheet opens in the Sheets section (the shell's
 * `openSheet`); a report or dashboard takes over the page you are on, and Back returns to what you
 * came from, including from a shortcut on a dashboard to a report and back to the dashboard.
 */
export function useAssetViewer(): { open: (type: AssetType, id: string, edit?: boolean) => void; element: ReactNode | null } {
  const { openSheet, userId } = useShell()
  const [stack, setStack] = useState<View[]>([])

  const open = useCallback(
    (type: AssetType, id: string, edit = false) => {
      pushRecent(userId, type, id)
      if (type === 'sheet') openSheet(id)
      else setStack((s) => [...s, { type, id, edit }])
    },
    [openSheet, userId],
  )
  const back = useCallback(() => setStack((s) => s.slice(0, -1)), [])

  const top = stack[stack.length - 1]
  const backLabel = stack.length > 1 ? 'Back' : undefined
  const element = top ? (
    top.type === 'report' ? (
      <ReportScreen key={`r${top.id}${stack.length}`} id={top.id} startInEdit={top.edit} onBack={back} backLabel={backLabel} />
    ) : (
      <DashboardScreen key={`d${top.id}${stack.length}`} id={top.id} startInEdit={top.edit} onBack={back} onOpen={open} backLabel={backLabel} />
    )
  ) : null
  return { open, element }
}
