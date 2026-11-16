// Fails if a built bundle contains the E2E fake Supabase client, or the NAME of the server-only
// service-role key (it must only ever be read by the Node server; if the name is in the bundle,
// something imported server code or a VITE_-prefixed variable). Runs after `vite build` as part
// of `npm run build`. Usage: node scripts/check-bundle.mjs [distDir]
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const dist = path.resolve(process.argv[2] ?? 'dist')
const NEEDLES = ['fakeSupabase', 'SUPABASE_SERVICE_ROLE_KEY', 'VITE_SUPABASE_SERVICE_ROLE_KEY']

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) yield* files(p)
    else yield p
  }
}

const all = [...files(dist)].map((f) => ({ f, text: readFileSync(f, 'utf8') }))
const hits = NEEDLES.flatMap((needle) => all.filter((x) => x.text.includes(needle)).map((x) => ({ needle, f: x.f })))
if (hits.length > 0) {
  console.error(`check-bundle: forbidden text found in the build output:\n  ${hits.map((h) => `"${h.needle}" in ${h.f}`).join('\n  ')}`)
  process.exit(1)
}
console.log(`check-bundle: ok, none of ${NEEDLES.map((n) => `"${n}"`).join(', ')} in ${path.relative(process.cwd(), dist) || dist}`)
