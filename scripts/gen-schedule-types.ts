// Writes supabase/migrations/0013_more_schedule_types.sql from the procurement module
// (src/procurement). The database is the master; this keeps the generated schedule types in step
// with the module's activities and logic.
//   npm run gen:schedule-types             write the migration
//   npm run gen:schedule-types -- --check  exit 1 if the committed migration is out of date
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { migration0013Sql } from '../src/procurement/dbCatalog'

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../supabase/migrations/0013_more_schedule_types.sql')
const sql = migration0013Sql()

if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== sql) {
    console.error('0013_more_schedule_types.sql is out of date: run `npm run gen:schedule-types`.')
    process.exit(1)
  }
  console.log('0013_more_schedule_types.sql is up to date.')
} else {
  writeFileSync(OUT, sql)
  console.log(`Wrote ${OUT}`)
}
