import type { SVGProps } from 'react'

/**
 * The wizard's few extra glyphs, drawn like the app's icon set (src/ui/Icon.tsx): 24px grid, 1.8
 * stroke, round caps, currentColor, always decorative. Kept here so the wizard owns its own icons.
 */
const PATHS = {
  close: 'M6 6l12 12M18 6 6 18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  checkCircle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-3.5-9 2.5 2.5 4.5-5',
  alertCircle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13.5v5.5m0 3h.01',
  clockAlert: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13.5V12l3 1.8',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-9v5m0-8.5h.01',
  plus: 'M12 5v14M5 12h14',
  trash: 'M5 7h14M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3',
  chevron: 'M6 9l6 6 6-6',
  back: 'M15 5l-7 7 7 7',
  sparkles: 'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3Zm7 11l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14Z',
  refresh: 'M20 11a8 8 0 0 0-14.5-4M4 4v4h4M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4',
  upload: 'M12 15V4M7 9l5-5 5 5M5 15v4a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4',
  history: 'M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4M12 8v4l3 2',
  calendar: 'M5 6h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Zm-1 5h16M8 3v4m8-4v4',
  // Equipment glyphs for the tiles.
  bolt: 'M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z',
  cog: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0-12v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1M7.7 16.3l-2.1 2.1',
  snow: 'M12 3v18M4.2 7.5l15.6 9m0-9-15.6 9',
  box: 'M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Zm0 9 8-4.5M12 12 4 7.5m8 4.5v9',
} as const

export type PIconName = keyof typeof PATHS

interface Props extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: PIconName
  size?: number
}

export function PIcon({ name, size = 18, ...rest }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  )
}

/** A glyph for an equipment type, guessed from its name (electrical, mechanical, cooling, or a generic box). */
export function equipmentGlyph(type: string): PIconName {
  const t = type.toLowerCase()
  if (/transformer|switch|breaker|cable|panel|generator|ups|battery|relay|motor control|electr/.test(t)) return 'bolt'
  if (/chill|boiler|hvac|cool|heat|furnace|ahu|air/.test(t)) return 'snow'
  if (/turbine|pump|compressor|fan|motor|crane|lift|elevator|engine/.test(t)) return 'cog'
  return 'box'
}
