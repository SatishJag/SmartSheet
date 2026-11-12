import { observeElementRect, type Rect, type Virtualizer } from '@tanstack/react-virtual'

/** Height assumed when the scroll element reports none (no layout yet, or jsdom). */
const FALLBACK_VIEWPORT_HEIGHT = 600

/** Observe the real element size, but never report a zero height (which would render no rows). */
export const measuredViewport = {
  observeElementRect: (instance: Virtualizer<HTMLDivElement, Element>, cb: (rect: Rect) => void) =>
    observeElementRect(instance, (rect) =>
      cb(rect.height > 0 ? rect : { width: rect.width, height: FALLBACK_VIEWPORT_HEIGHT }),
    ),
}

/**
 * Virtualizer options for a known viewport height: the rect is fixed instead of observed,
 * which also lets jsdom (no layout) window the rows.
 */
export function fixedViewport(height: number) {
  const rect: Rect = { width: 0, height }
  return {
    initialRect: rect,
    observeElementRect: (_instance: Virtualizer<HTMLDivElement, Element>, cb: (rect: Rect) => void) => {
      cb(rect)
      return () => {}
    },
  }
}
