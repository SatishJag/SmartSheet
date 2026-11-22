/**
 * Procore's own sites: the only pages allowed to frame /procore, and the only windows whose messages the
 * panel trusts (docs/superpowers/specs/2026-11-22-procore-panel-design.md). Procore's regions and the
 * Developer Sandbox; add new regions here as Procore launches them.
 */
export const PROCORE_ORIGINS: readonly string[] = ['https://app.procore.com', 'https://us02.procore.com', 'https://uk01.procore.com', 'https://sandbox.procore.com']

export const isProcoreOrigin = (origin: string): boolean => PROCORE_ORIGINS.includes(origin)

/** The page Procore shows in its side panel and full screen. */
export const PROCORE_PANEL_PATH = '/procore'

/** True for /procore and /procore/ only. */
export const isPanelPath = (pathname: string): boolean => pathname === PROCORE_PANEL_PATH || pathname === `${PROCORE_PANEL_PATH}/`
