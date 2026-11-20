/** Geometry for the SVG charts: axis ticks, number text, arcs. Pure, so it is unit-tested without a DOM. */

export interface Ticks {
  values: number[]
  min: number
  max: number
}

/** Round axis ticks that include 0 and cover [min, max]; about `count` steps. */
export function niceTicks(min: number, max: number, count = 4, integers = false): Ticks {
  const lo = Math.min(0, min)
  const hi = Math.max(0, max)
  if (hi === lo) return { values: [0, 1], min: 0, max: 1 }
  const raw = (hi - lo) / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / mag
  let step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag
  if (integers) step = Math.max(1, Math.ceil(step))
  const first = Math.floor(lo / step) * step
  const last = Math.ceil(hi / step) * step
  const values: number[] = []
  for (let v = first; v <= last + step / 2; v += step) values.push(Math.round(v / step) * step)
  return { values, min: first, max: last }
}

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
const plain = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })

/** An axis or bar label: 1.2K / 3.4M for big numbers, up to 2 decimals otherwise. */
export const formatTick = (n: number) => (Math.abs(n) >= 10_000 ? compact.format(n) : plain.format(n))
export const formatFull = (n: number) => plain.format(n)

export interface Slice {
  index: number
  value: number
  /** Fraction of the total, 0..1. */
  share: number
  /** Start and end angle in radians, clockwise from 12 o'clock. */
  start: number
  end: number
}

/** Pie slices for non-negative values; zero and negative values get no slice. */
export function pieSlices(values: readonly number[]): Slice[] {
  const total = values.reduce((n, v) => n + Math.max(0, v), 0)
  if (total <= 0) return []
  const out: Slice[] = []
  let angle = 0
  values.forEach((v, index) => {
    if (v <= 0) return
    const share = v / total
    out.push({ index, value: v, share, start: angle, end: angle + share * Math.PI * 2 })
    angle += share * Math.PI * 2
  })
  return out
}

const point = (cx: number, cy: number, r: number, a: number) => [cx + r * Math.sin(a), cy - r * Math.cos(a)] as const
const fix = (n: number) => Math.round(n * 100) / 100

/** SVG path of a slice; `inner` > 0 makes a ring segment (donut). A full circle is drawn as two halves. */
export function slicePath(cx: number, cy: number, outer: number, inner: number, start: number, end: number): string {
  const full = end - start >= Math.PI * 2 - 1e-6
  const e = full ? start + Math.PI * 2 - 1e-4 : end
  const large = e - start > Math.PI ? 1 : 0
  const [x1, y1] = point(cx, cy, outer, start)
  const [x2, y2] = point(cx, cy, outer, e)
  if (inner <= 0) return `M${fix(cx)} ${fix(cy)}L${fix(x1)} ${fix(y1)}A${outer} ${outer} 0 ${large} 1 ${fix(x2)} ${fix(y2)}Z`
  const [x3, y3] = point(cx, cy, inner, e)
  const [x4, y4] = point(cx, cy, inner, start)
  return `M${fix(x1)} ${fix(y1)}A${outer} ${outer} 0 ${large} 1 ${fix(x2)} ${fix(y2)}L${fix(x3)} ${fix(y3)}A${inner} ${inner} 0 ${large} 0 ${fix(x4)} ${fix(y4)}Z`
}

/** Cuts a label to `max` characters with an ellipsis. */
export const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s)
