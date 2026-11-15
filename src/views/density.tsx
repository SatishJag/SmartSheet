import { createContext, useContext } from 'react'

/** Compact is the default in a sheet: dense working views. Comfortable gives rows more air. */
export type Density = 'compact' | 'comfortable'

/** Row heights in px. The grid's virtualizer, the Gantt rows and the bars all follow this. */
export const ROW_HEIGHTS: Record<Density, number> = { compact: 32, comfortable: 40 }

export const DENSITY_STORAGE_KEY = 'smartsheet-density'

export function readDensity(): Density {
  try {
    const saved = localStorage.getItem(DENSITY_STORAGE_KEY)
    return saved === 'comfortable' ? 'comfortable' : 'compact'
  } catch {
    return 'compact'
  }
}

export function saveDensity(d: Density): void {
  try {
    localStorage.setItem(DENSITY_STORAGE_KEY, d)
  } catch {
    /* not remembered; still applies for this visit */
  }
}

const DensityContext = createContext<Density>('compact')
export const DensityProvider = DensityContext.Provider

export function useDensity(): { density: Density; rowHeight: number } {
  const density = useContext(DensityContext)
  return { density, rowHeight: ROW_HEIGHTS[density] }
}
