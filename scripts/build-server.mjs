// Builds the planning server to dist-server/ (tsconfig.server.json) and marks that directory as
// CommonJS: the repo's package.json says "type": "module", but the server compiles to CommonJS so
// the extensionless imports it shares with the browser code resolve under Node.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const out = path.resolve('dist-server')
rmSync(out, { recursive: true, force: true })
const tsc = path.join(path.dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc')
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.server.json'], { stdio: 'inherit' })
mkdirSync(out, { recursive: true })
writeFileSync(path.join(out, 'package.json'), JSON.stringify({ type: 'commonjs' }) + '\n')
console.log('build-server: ok, dist-server/server/main.js')
