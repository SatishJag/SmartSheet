// Colour themes: the brand scale is a set of CSS variables in src/theme.css; choosing a theme sets
// data-theme on <html>, is remembered per browser and updates the browser bar colour (theme-color meta).
// The same list and key are mirrored by the inline script in index.html that applies the saved theme
// before first paint, keep them in sync.

export interface ThemeInfo {
  id: string
  label: string
  /** The 600/700-step colour: swatch fill and browser bar colour. */
  color: string
}

export const THEMES: readonly ThemeInfo[] = [
  { id: 'orange', label: 'Orange', color: '#ea580c' },
  { id: 'blue', label: 'Blue', color: '#2563eb' },
  { id: 'purple', label: 'Purple', color: '#7c3aed' },
  { id: 'green', label: 'Green', color: '#16a34a' },
  { id: 'red', label: 'Red', color: '#dc2626' },
  { id: 'teal', label: 'Teal', color: '#0d9488' },
  { id: 'grey', label: 'Grey', color: '#475569' },
  { id: 'black', label: 'Black', color: '#171717' },
]

export const DEFAULT_THEME = 'orange'
export const THEME_STORAGE_KEY = 'smartsheet-theme'

const known = (id: string | null | undefined): id is string => THEMES.some((t) => t.id === id)

export function readTheme(): string {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY)
    return known(saved) ? saved : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME // storage blocked (private window, site data disabled)
  }
}

/** Sets data-theme and the theme-color meta, and remembers the choice. Returns the theme applied. */
export function applyTheme(id: string): string {
  const theme = known(id) ? id : DEFAULT_THEME
  document.documentElement.dataset.theme = theme
  const color = THEMES.find((t) => t.id === theme)?.color
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta && color) meta.setAttribute('content', color)
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    /* not remembered; the theme still applies for this visit */
  }
  return theme
}

export const initTheme = (): string => applyTheme(readTheme())
