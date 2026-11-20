import { useLayoutEffect, useState, type RefObject } from 'react'

/** The content size of an element, kept up to date with a ResizeObserver (the fallback is used where there is none, as in jsdom). */
export function useSize(ref: RefObject<HTMLElement | null>, fallback = { width: 480, height: 260 }) {
  const [size, setSize] = useState(fallback)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) setSize((s) => (Math.abs(s.width - r.width) < 1 && Math.abs(s.height - r.height) < 1 ? s : { width: r.width, height: r.height }))
    }
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return size
}
