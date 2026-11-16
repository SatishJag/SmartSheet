import { useId, useRef } from 'react'
import { formatFull, formatTick, niceTicks, pieSlices, slicePath, truncate } from './chartMath'
import type { ChartKind } from './types'
import type { ChartData } from './widgetData'
import { useSize } from './useSize'

/** Series colours: the brand scale and the neutral and status tokens, so every theme recolours the chart. */
export const PALETTE = [
  'rgb(var(--b600))',
  'var(--info)',
  'var(--ok)',
  'rgb(var(--b300))',
  'var(--ink-2)',
  'var(--warn)',
  'rgb(var(--b800))',
  'var(--ink-3)',
]
const color = (i: number) => PALETTE[i % PALETTE.length]

interface Props {
  data: ChartData
  kind: ChartKind
  /** Accessible name, e.g. the widget title. */
  label: string
}

/**
 * Dependency-free SVG charts (bar, column, line, pie, donut, stacked) drawn at the size of their box.
 * Every chart carries a text alternative (a hidden table of the same numbers) and a native tooltip
 * (<title>) per mark; colour is never the only way to read a value (labels, legend with values).
 */
export function Chart({ data, kind, label }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const { width, height } = useSize(box)
  const tableId = useId()
  const pie = kind === 'pie' || kind === 'donut'
  const legendItems = pie ? data.categories.map((c, i) => ({ name: c, value: data.series[0]?.values[i] ?? 0, index: i })).filter((x) => x.value > 0) : data.series.length > 1 ? data.series.map((s, i) => ({ name: s.name, value: null, index: i })) : []
  const total = data.series.reduce((n, s) => n + s.values.reduce((a, b) => a + b, 0), 0)

  return (
    <div className="chart">
      <div ref={box} className="chart-box">
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`${label}: ${kind} chart of ${data.categories.length} values`}
          aria-describedby={tableId}
        >
          {pie ? <PieChart data={data} donut={kind === 'donut'} width={width} height={height} total={total} /> : kind === 'bar' ? <BarsH data={data} width={width} height={height} /> : kind === 'line' ? <Lines data={data} width={width} height={height} /> : <Columns data={data} stacked={kind === 'stacked'} width={width} height={height} />}
        </svg>
      </div>
      {legendItems.length > 0 && (
        <ul className="chart-legend">
          {legendItems.map((item) => (
            <li key={item.name}>
              <span className="chart-swatch" style={{ background: color(item.index) }} aria-hidden="true" />
              {item.name}
              {item.value !== null && <span className="chart-legend-value">{formatFull(item.value)}</span>}
            </li>
          ))}
        </ul>
      )}
      <table id={tableId} className="visually-hidden">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">Category</th>
            {data.series.map((s) => (
              <th key={s.name} scope="col">
                {s.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.categories.map((c, i) => (
            <tr key={c}>
              <th scope="row">{c}</th>
              {data.series.map((s) => (
                <td key={s.name}>{formatFull(s.values[i] ?? 0)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

interface Sized {
  data: ChartData
  width: number
  height: number
}

const M = { top: 14, right: 12, bottom: 30, left: 44 }

function stackedTotals(data: ChartData, stacked: boolean) {
  return data.categories.map((_, i) => (stacked ? data.series.reduce((n, s) => n + Math.max(0, s.values[i] ?? 0), 0) : (data.series[0]?.values[i] ?? 0)))
}

function Axis({ ticks, width, height, y }: { ticks: number[]; width: number; height: number; y: (v: number) => number }) {
  return (
    <g className="chart-axis">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} className={t === 0 ? 'chart-zero' : 'chart-grid'} />
          <text x={M.left - 6} y={y(t)} textAnchor="end" dominantBaseline="middle">
            {formatTick(t)}
          </text>
        </g>
      ))}
      <rect x={0} y={0} width={width} height={height} fill="none" />
    </g>
  )
}

/** x-axis labels, rotated when the bands are narrow. */
function XLabels({ cats, x, band, y }: { cats: string[]; x: (i: number) => number; band: number; y: number }) {
  const rotate = band < 54
  const max = rotate ? 12 : Math.max(4, Math.floor(band / 6.5))
  const every = band < 18 ? Math.ceil(18 / band) : 1
  return (
    <g className="chart-axis">
      {cats.map((c, i) =>
        i % every === 0 ? (
          <text
            key={c}
            x={x(i)}
            y={y + 14}
            textAnchor={rotate ? 'end' : 'middle'}
            transform={rotate ? `rotate(-35 ${x(i)} ${y + 14})` : undefined}
          >
            {truncate(c, max)}
            <title>{c}</title>
          </text>
        ) : null,
      )}
    </g>
  )
}

function Columns({ data, stacked, width, height }: Sized & { stacked: boolean }) {
  const totals = stackedTotals(data, stacked)
  const all = data.series.flatMap((s) => s.values)
  const ticks = niceTicks(stacked ? 0 : Math.min(0, ...all), Math.max(0, ...totals), 4, all.every(Number.isInteger))
  const band = (width - M.left - M.right) / Math.max(1, data.categories.length)
  const bottom = height - M.bottom - (band < 54 ? 22 : 0) // room for rotated labels
  const y = (v: number) => M.top + ((ticks.max - v) / (ticks.max - ticks.min)) * (bottom - M.top)
  const cx = (i: number) => M.left + band * (i + 0.5)
  const barW = Math.min(56, band * 0.68)
  return (
    <>
      <Axis ticks={ticks.values} width={width} height={height} y={y} />
      {data.categories.map((cat, i) => {
        let acc = 0
        return (
          <g key={cat}>
            {data.series.map((s, k) => {
              const v = s.values[i] ?? 0
              const from = stacked ? acc : 0
              const to = stacked ? acc + Math.max(0, v) : v
              if (stacked) acc = to
              const top = Math.min(y(from), y(to))
              const h = Math.max(v === 0 ? 0 : 1, Math.abs(y(from) - y(to)))
              return (
                <rect key={s.name} x={cx(i) - barW / 2} y={top} width={barW} height={h} rx={3} fill={color(stacked ? k : 0)} className="chart-bar">
                  <title>{`${cat}${stacked ? ` · ${s.name}` : ''}: ${formatFull(v)}`}</title>
                </rect>
              )
            })}
            {!stacked && barW >= 22 && data.categories.length <= 14 && (
              <text x={cx(i)} y={y(Math.max(0, data.series[0]?.values[i] ?? 0)) - 4} textAnchor="middle" className="chart-value">
                {formatTick(data.series[0]?.values[i] ?? 0)}
              </text>
            )}
          </g>
        )
      })}
      <XLabels cats={data.categories} x={cx} band={band} y={bottom} />
    </>
  )
}

function Lines({ data, width, height }: Sized) {
  const all = data.series.flatMap((s) => s.values)
  const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all), 4, all.every(Number.isInteger))
  const band = (width - M.left - M.right) / Math.max(1, data.categories.length)
  const bottom = height - M.bottom - (band < 54 ? 22 : 0)
  const y = (v: number) => M.top + ((ticks.max - v) / (ticks.max - ticks.min)) * (bottom - M.top)
  const cx = (i: number) => M.left + band * (i + 0.5)
  return (
    <>
      <Axis ticks={ticks.values} width={width} height={height} y={y} />
      {data.series.map((s, k) => (
        <g key={s.name}>
          <polyline fill="none" stroke={color(k)} strokeWidth={2.5} strokeLinejoin="round" points={s.values.map((v, i) => `${cx(i)},${y(v)}`).join(' ')} />
          {s.values.map((v, i) => (
            <circle key={data.categories[i]} cx={cx(i)} cy={y(v)} r={4} fill="var(--surface)" stroke={color(k)} strokeWidth={2.5}>
              <title>{`${data.categories[i]}: ${formatFull(v)}`}</title>
            </circle>
          ))}
        </g>
      ))}
      <XLabels cats={data.categories} x={cx} band={band} y={bottom} />
    </>
  )
}

function BarsH({ data, width, height }: Sized) {
  const values = data.series[0]?.values ?? []
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values), 4, values.every(Number.isInteger))
  const labelW = Math.min(140, Math.max(60, ...data.categories.map((c) => Math.min(c.length, 20) * 6.4)))
  const left = labelW + 10
  const right = 40
  const top = 6
  const bottom = height - 22
  const band = (bottom - top) / Math.max(1, data.categories.length)
  const x = (v: number) => left + ((v - ticks.min) / (ticks.max - ticks.min)) * (width - left - right)
  const barH = Math.min(30, band * 0.7)
  return (
    <>
      <g className="chart-axis">
        {ticks.values.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={top} y2={bottom} className={t === 0 ? 'chart-zero' : 'chart-grid'} />
            <text x={x(t)} y={bottom + 14} textAnchor="middle">
              {formatTick(t)}
            </text>
          </g>
        ))}
        {data.categories.map((c, i) => (
          <text key={c} x={left - 8} y={top + band * (i + 0.5)} textAnchor="end" dominantBaseline="middle">
            {truncate(c, 20)}
            <title>{c}</title>
          </text>
        ))}
      </g>
      {values.map((v, i) => (
        <g key={data.categories[i]}>
          <rect x={Math.min(x(0), x(v))} y={top + band * (i + 0.5) - barH / 2} width={Math.max(v === 0 ? 0 : 1, Math.abs(x(v) - x(0)))} height={barH} rx={3} fill={color(0)} className="chart-bar">
            <title>{`${data.categories[i]}: ${formatFull(v)}`}</title>
          </rect>
          <text x={Math.max(x(0), x(v)) + 5} y={top + band * (i + 0.5)} dominantBaseline="middle" className="chart-value">
            {formatTick(v)}
          </text>
        </g>
      ))}
    </>
  )
}

function PieChart({ data, donut, width, height, total }: Sized & { donut: boolean; total: number }) {
  const values = data.series[0]?.values ?? []
  const slices = pieSlices(values)
  const r = Math.max(20, Math.min(width, height) / 2 - 8)
  const cx = width / 2
  const cy = height / 2
  return (
    <g>
      {slices.map((s) => (
        <path key={data.categories[s.index]} d={slicePath(cx, cy, r, donut ? r * 0.58 : 0, s.start, s.end)} fill={color(s.index)} stroke="var(--surface)" strokeWidth={2} className="chart-bar">
          <title>{`${data.categories[s.index]}: ${formatFull(s.value)} (${Math.round(s.share * 100)}%)`}</title>
        </path>
      ))}
      {slices
        .filter((s) => s.share >= 0.07)
        .map((s) => {
          const a = (s.start + s.end) / 2
          const rr = donut ? r * 0.79 : r * 0.62
          return (
            <text key={`l${s.index}`} x={cx + rr * Math.sin(a)} y={cy - rr * Math.cos(a)} textAnchor="middle" dominantBaseline="middle" className="chart-pie-label">
              {Math.round(s.share * 100)}%
            </text>
          )
        })}
      {donut && (
        <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle" className="chart-donut-total">
          {formatTick(total)}
        </text>
      )}
    </g>
  )
}
