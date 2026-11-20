import { useRef } from 'react'
import { truncate } from './chartMath'
import { addDays, daysBetween } from './values'
import type { TimeData, TimeItem } from './widgetData'
import { useSize } from './useSize'

interface Props {
  data: TimeData
  /** `gantt`: a name column and one bar per row. `timeline`: items packed into lanes along one axis. */
  mode: 'gantt' | 'timeline'
  label: string
  today: string
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The first of each month inside [from, to], as dates. */
function monthStarts(from: string, to: string): string[] {
  const out: string[] = []
  let [y, m] = from.split('-').map(Number)
  const end = to
  for (let guard = 0; guard < 240; guard++) {
    const iso = `${y}-${String(m).padStart(2, '0')}-01`
    if (iso > end) break
    if (iso >= from) out.push(iso)
    m++
    if (m > 12) {
      m = 1
      y++
    }
  }
  return out
}

/** Every Monday inside [from, to]. */
function mondays(from: string, to: string): string[] {
  const [y, m, d] = from.split('-').map(Number)
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  const out: string[] = []
  for (let day = addDays(from, (8 - dow) % 7); day <= to && out.length < 80; day = addDays(day, 7)) out.push(day)
  return out
}

const fmt = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return `${d} ${MONTHS[m - 1]} ${y}`
}

/**
 * Dependency-free SVG Gantt grid and timeline over dated items (a sheet or report with a start and an end
 * column). Bars use the brand colour; a diamond is an item with no end date; the accent line is today.
 */
export function TimelineChart({ data, mode, label, today }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const { width } = useSize(box)

  if (data.items.length === 0 || !data.min || !data.max) return null
  const from = addDays(data.min, -2)
  const to = addDays(data.max, 3)
  const span = Math.max(1, daysBetween(from, to))
  const gantt = mode === 'gantt'
  const labelW = gantt ? Math.min(200, Math.max(92, width * 0.26)) : 0
  const left = labelW + 8
  const plotW = Math.max(120, width - left - 12)
  const x = (iso: string) => left + (daysBetween(from, iso) / span) * plotW
  const months = monthStarts(from, to)
  const monthW = plotW / (span / 30.4)
  // Short programmes get a week scale under the months, so the axis is never just one month label.
  const weekW = plotW / (span / 7)
  const weeks = span <= 150 && weekW >= 30 ? mondays(from, to) : []
  const head = weeks.length > 0 ? 46 : 30
  const rowH = gantt ? 28 : 34

  // Timeline lanes: the first lane whose last item ended before this one starts (its label included).
  const lanes: number[] = []
  const laneOf = new Map<string, number>()
  if (!gantt) {
    for (const item of data.items) {
      const startX = x(item.start)
      const endX = Math.max(x(item.end), startX + 10) + item.label.length * 6.1 + 14
      let lane = lanes.findIndex((last) => last < startX - 2)
      if (lane === -1) lane = lanes.push(endX) - 1
      else lanes[lane] = endX
      laneOf.set(item.id, lane)
    }
  }
  const rows = gantt ? data.items.length : lanes.length
  const height = head + rows * rowH + 8
  const todayX = today >= from && today <= to ? x(today) : null
  const at = (item: TimeItem, i: number) => head + (gantt ? i : (laneOf.get(item.id) ?? 0)) * rowH

  return (
    <div ref={box} className="timeline-box">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label}: ${data.items.length} items from ${fmt(data.min)} to ${fmt(data.max)}`}>
        <g className="chart-axis">
          {weeks.map((wk) => (
            <g key={wk}>
              <line x1={x(wk)} x2={x(wk)} y1={head - 6} y2={height - 4} className="timeline-week" />
              <text x={x(wk) + 3} y={head - 12} className="timeline-week-label">
                {weekW >= 52 ? `${Number(wk.slice(8))} ${MONTHS[Number(wk.slice(5, 7)) - 1]}` : Number(wk.slice(8))}
              </text>
            </g>
          ))}
          {months.map((m) => {
            const [, mo] = m.split('-').map(Number)
            return (
              <g key={m}>
                <line x1={x(m)} x2={x(m)} y1={head - (weeks.length > 0 ? 30 : 6)} y2={height - 4} className="chart-grid" />
                <text x={x(m) + 4} y={head - (weeks.length > 0 ? 32 : 12)} className="timeline-month-label">
                  {monthW >= 44 ? `${MONTHS[mo - 1]}${mo === 1 || m === months[0] ? ` ${m.slice(0, 4)}` : ''}` : MONTHS[mo - 1][0]}
                </text>
              </g>
            )
          })}
        </g>
        {gantt &&
          data.items.map((item, i) =>
            i % 2 === 1 ? <rect key={`z${item.id}`} x={0} y={at(item, i)} width={width} height={rowH} className="timeline-zebra" /> : null,
          )}
        {todayX !== null && (
          <g>
            <line x1={todayX} x2={todayX} y1={head - 6} y2={height - 4} className="timeline-today" />
            <text x={todayX + 4} y={height - 8} className="timeline-today-label">
              Today
            </text>
          </g>
        )}
        {data.items.map((item, i) => {
          const y = at(item, i)
          const x1 = x(item.start)
          const x2 = Math.max(x(item.end), x1 + 6)
          const tip = item.milestone ? `${item.label}: ${fmt(item.start)}` : `${item.label}: ${fmt(item.start)} to ${fmt(item.end)}`
          const mid = y + rowH / 2
          return (
            <g key={item.id}>
              {gantt && (
                <text x={8} y={mid} dominantBaseline="middle" className="timeline-label">
                  {truncate(item.label, Math.max(8, Math.floor(labelW / 6.4)))}
                  <title>{item.label}</title>
                </text>
              )}
              {item.milestone ? (
                <polygon points={`${x1},${mid - 8} ${x1 + 8},${mid} ${x1},${mid + 8} ${x1 - 8},${mid}`} className="timeline-milestone">
                  <title>{tip}</title>
                </polygon>
              ) : (
                <rect x={x1} y={mid - 8} width={x2 - x1} height={16} rx={5} className="timeline-bar">
                  <title>{tip}</title>
                </rect>
              )}
              {!gantt && (
                <text x={(item.milestone ? x1 + 13 : x2 + 6)} y={mid} dominantBaseline="middle" className="timeline-label">
                  {item.label}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      {data.note && <p className="widget-note">{data.note}</p>}
    </div>
  )
}
