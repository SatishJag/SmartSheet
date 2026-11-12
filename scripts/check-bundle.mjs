// Fails if a built bundle contains the E2E fake Supabase client. Runs after `vite build` as part
// of `npm run build`. Usage: node scripts/check-bundle.mjs [distDir]
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const dist = path.resolve(process.argv[2] ?? 'dist')
const NEEDLE = 'fakeSupabase'

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) yield* files(p)
    else yield p
  }
}

const hits = [...files(dist)].filter((f) => readFileSync(f, 'utf8').includes(NEEDLE))
if (hits.length > 0) {
  console.error(`check-bundle: "${NEEDLE}" found in the build output:\n  ${hits.join('\n  ')}`)
  process.exit(1)
}
console.log(`check-bundle: ok, no "${NEEDLE}" in ${path.relative(process.cwd(), dist) || dist}`)
