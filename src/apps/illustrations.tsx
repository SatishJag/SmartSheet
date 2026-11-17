import type { AppTemplate } from './types'

/** Simple flat illustrations for the template gallery (decorative). */
export function Illustration({ kind }: { kind: AppTemplate['illustration'] }) {
  const ground = <rect x="0" y="118" width="240" height="42" fill="#cfd3e6" />
  return (
    <svg viewBox="0 0 240 160" className="app-illustration" aria-hidden="true" focusable="false">
      <rect width="240" height="160" fill="#e9eaf4" />
      {ground}
      {kind === 'crane' && (
        <g>
          <rect x="58" y="30" width="8" height="90" fill="#7c81c9" />
          <rect x="40" y="30" width="100" height="6" fill="#7c81c9" />
          <rect x="44" y="114" width="36" height="6" fill="#5c62b8" />
          <circle cx="62" cy="22" r="5" fill="#e3a21a" />
          <line x1="118" y1="36" x2="118" y2="64" stroke="#5c62b8" strokeWidth="2" />
          <rect x="106" y="64" width="24" height="12" fill="#1f2f80" />
          <rect x="140" y="62" width="26" height="56" fill="#b7b9dd" />
          <rect x="140" y="88" width="26" height="30" fill="#7c81c9" />
          <rect x="176" y="80" width="26" height="38" fill="#1f2f80" />
          <rect x="100" y="94" width="26" height="24" fill="#fff" />
        </g>
      )}
      {kind === 'datacenter' && (
        <g>
          {[40, 80, 120, 160].map((x, i) => (
            <g key={x}>
              <rect x={x} y={44} width="30" height="74" fill={i % 2 ? '#5c62b8' : '#1f2f80'} rx="2" />
              {[0, 1, 2, 3, 4, 5].map((r) => (
                <rect key={r} x={x + 5} y={52 + r * 10} width="20" height="5" fill="#b7b9dd" />
              ))}
              <circle cx={x + 24} cy={110} r="2" fill={i === 2 ? '#e3a21a' : '#7ee0a1'} />
            </g>
          ))}
          <path d="M20 40 Q60 10 100 30 T200 24" stroke="#7c81c9" strokeWidth="3" fill="none" />
          <rect x="196" y="74" width="28" height="44" fill="#7c81c9" />
          <path d="M204 80 l6 10 h-5 l5 12" stroke="#e3a21a" strokeWidth="3" fill="none" />
        </g>
      )}
      {kind === 'buildings' && (
        <g>
          <rect x="30" y="58" width="44" height="60" fill="#7c81c9" />
          <rect x="82" y="26" width="50" height="92" fill="#1f2f80" />
          <rect x="140" y="48" width="40" height="70" fill="#b7b9dd" />
          <rect x="186" y="78" width="30" height="40" fill="#5c62b8" />
          {[0, 1, 2, 3, 4, 5].map((r) =>
            [0, 1, 2].map((c) => <rect key={`${r}-${c}`} x={88 + c * 14} y={34 + r * 13} width="9" height="7" fill="#b7b9dd" />),
          )}
          <rect x="190" y="56" width="18" height="12" fill="#e3a21a" />
          <rect x="198" y="68" width="2" height="10" fill="#5c62b8" />
        </g>
      )}
      {kind === 'fitout' && (
        <g>
          <rect x="30" y="30" width="180" height="88" fill="#fff" stroke="#b7b9dd" />
          <rect x="44" y="84" width="60" height="8" fill="#1f2f80" />
          <rect x="48" y="92" width="4" height="26" fill="#1f2f80" />
          <rect x="96" y="92" width="4" height="26" fill="#1f2f80" />
          <rect x="120" y="70" width="22" height="48" fill="#7c81c9" />
          <rect x="150" y="44" width="46" height="30" fill="#b7b9dd" />
          <circle cx="173" cy="100" r="12" fill="#5c62b8" />
          <rect x="60" y="40" width="30" height="30" fill="#e9eaf4" stroke="#7c81c9" />
          <circle cx="75" cy="55" r="5" fill="#e3a21a" />
        </g>
      )}
    </svg>
  )
}
