import type { SVGProps } from 'react'
import { Icon, type IconName } from '../ui/Icon'
import type { AssetType, WidgetType } from './types'

/** The few icons the smart assets need beyond the shared set (src/ui/Icon.tsx), same grid and stroke. */
const EXTRA = {
  star: 'M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8L12 3.6Z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm9 3-4.3-4.3',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  close: 'M6 6l12 12M18 6 6 18',
  download: 'M12 4v11m0 0-4-4m4 4 4-4M5 20h14',
  refresh: 'M20 12a8 8 0 1 1-2.4-5.7M20 4v5h-5',
  report: 'M7 3h7l5 5v13H7V3Zm7 0v5h5M10 13h6M10 17h6',
  dashboard: 'M4 4h7v9H4V4Zm9 0h7v5h-7V4ZM4 15h7v5H4v-5Zm9-4h7v9h-7v-9Z',
  move: 'M5 12h14m-4-4 4 4-4 4M9 7 5 12l4 5',
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  up: 'M12 19V5m0 0-5 5m5-5 5 5',
  down: 'M12 5v14m0 0-5-5m5 5 5-5',
  image: 'M4 5h16v14H4V5Zm0 11 4.5-4.5 3.5 3.5 2.5-2.5L20 16M9 9.5h.01',
  text: 'M5 6h14M5 11h14M5 16h9',
  title: 'M5 6h14M12 6v13M9 19h6',
  metric: 'M5 9h14M5 15h14M10 4 8 20m8-16-2 16',
  timeline: 'M3 12h18M7 8v8m5-10v12m5-9v6',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  filter: 'M4 5h16l-6 7v6l-4 2v-8L4 5Z',
  home: 'M4 11 12 4l8 7v9H4v-9Zm5 9v-6h6v6',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13v5l3 2',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Zm9.5 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6v-9Z',
} as const

export type AssetIconName = IconName | keyof typeof EXTRA

interface Props extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: AssetIconName
  size?: number
  /** Fills the shape (a starred star). */
  filled?: boolean
}

export function AssetIcon({ name, size = 20, filled = false, ...rest }: Props) {
  if (!(name in EXTRA)) return <Icon name={name as IconName} size={size} {...rest} />
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={name === 'more' || name === 'grip' ? 2.6 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={EXTRA[name as keyof typeof EXTRA]} />
    </svg>
  )
}

export const ASSET_ICON: Record<AssetType, AssetIconName> = { sheet: 'sheet', report: 'report', dashboard: 'dashboard' }
export const ASSET_LABEL: Record<AssetType, string> = { sheet: 'Sheet', report: 'Report', dashboard: 'Dashboard' }

export const WIDGET_ICON: Record<WidgetType, AssetIconName> = {
  title: 'title',
  text: 'text',
  image: 'image',
  metric: 'metric',
  chart: 'chart',
  gantt: 'gantt',
  timeline: 'timeline',
  shortcut: 'link',
}

export const WIDGET_LABEL: Record<WidgetType, string> = {
  title: 'Title',
  text: 'Text',
  image: 'Image',
  metric: 'Metric',
  chart: 'Chart',
  gantt: 'Gantt grid',
  timeline: 'Timeline',
  shortcut: 'Shortcuts',
}
