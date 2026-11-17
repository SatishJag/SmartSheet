import type { Person } from './types'

const COLORS = ['#3b5bdb', '#0c8599', '#2b8a3e', '#e67700', '#c2255c', '#6741d9', '#5c940d', '#1864ab']

export function initials(p: Pick<Person, 'first_name' | 'last_name'>): string {
  return `${p.first_name.charAt(0)}${p.last_name.charAt(0)}`.toUpperCase()
}

function colorFor(id: string): string {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return COLORS[h % COLORS.length]
}

export function Avatar({ person, size = 32 }: { person: Person; size?: number }) {
  return (
    <span
      className="rm-avatar"
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: size * 0.4, background: colorFor(person.id) }}
    >
      {initials(person)}
    </span>
  )
}
