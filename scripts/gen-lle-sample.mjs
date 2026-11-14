// Generates supabase/migrations/0005_planner_lle_sample.sql: the 'lle-procurement' schedule type,
// its activity catalog and SAMPLE historical projects for the AI master planner.
//
// The figures are REPRESENTATIVE SAMPLES, not real project history: typical working-day durations
// for long-lead equipment procurement, varied with a seeded random generator. They exist so the
// planner works before the company loads its own history, and every project is marked
// is_sample = true so the planner can say so. Replace them with real data.
//
// Deterministic: the same script always produces the same SQL.
//   node scripts/gen-lle-sample.mjs           write the migration
//   node scripts/gen-lle-sample.mjs --check   exit 1 if the committed migration is out of date
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../supabase/migrations/0005_planner_lle_sample.sql')
const TYPE = 'lle-procurement'
const SAMPLE_NOTE = 'SAMPLE DATA: representative figures, not a real project. Replace with company history.'

// ---- Activity catalog -------------------------------------------------------------------
// [code, name, phase, defaultDays, links ([from, type, lagDays])]; sequence = position.
const fs = (from, lagDays = 0) => [from, 'FS', lagDays]
const ss = (from, lagDays = 0) => [from, 'SS', lagDays]
const CATALOG = [
  ['SPEC', 'Technical specification and requisition', 'Engineering', 15, []],
  ['RFQ', 'RFQ issue and bid period', 'Procurement', 20, [fs('SPEC')]],
  ['BIDEVAL', 'Technical and commercial bid evaluation', 'Procurement', 10, [fs('RFQ')]],
  ['AWARD', 'Award and purchase order', 'Procurement', 5, [fs('BIDEVAL')]],
  ['DWGSUB', 'Vendor drawings submittal', 'Engineering', 20, [fs('AWARD')]],
  ['DWGAPP', 'Drawing review and approval', 'Engineering', 10, [fs('DWGSUB')]],
  // Vendors order long-lead raw material once the main drawings are under review.
  ['RAWMAT', 'Raw material procurement', 'Manufacturing', 30, [ss('DWGAPP', 5)]],
  // Manufacturing needs approved drawings and the first raw material deliveries.
  ['MFG', 'Manufacturing', 'Manufacturing', 60, [fs('DWGAPP'), ss('RAWMAT', 15)]],
  ['FAT', 'Factory acceptance test', 'Quality', 5, [fs('MFG')]],
  ['RELEASE', 'Release for shipment and packing', 'Logistics', 5, [fs('FAT')]],
  ['SHIP', 'Shipping', 'Logistics', 25, [fs('RELEASE')]],
  ['CUSTOMS', 'Customs clearance', 'Logistics', 5, [fs('SHIP')]],
  ['DELIVER', 'Inland transport and delivery to site', 'Logistics', 5, [fs('CUSTOMS')]],
  ['ONSITE', 'On site', 'Milestone', 0, [fs('DELIVER')]],
]
const TARGET = 'ONSITE'

// ---- Equipment profiles ------------------------------------------------------------------
// Typical (median) working days per activity, and how many sample projects to generate.
const EQUIPMENT = [
  {
    type: 'Power transformer',
    count: 8,
    names: ['132/33 kV 90 MVA power transformer', '220/132 kV 160 MVA power transformer', '33/11 kV 20 MVA power transformer', '400/220 kV 315 MVA autotransformer'],
    days: { SPEC: 15, RFQ: 25, BIDEVAL: 12, AWARD: 6, DWGSUB: 25, DWGAPP: 12, RAWMAT: 45, MFG: 95, FAT: 6, RELEASE: 6, SHIP: 32, CUSTOMS: 7, DELIVER: 7 },
  },
  {
    type: 'HV switchgear',
    count: 7,
    names: ['132 kV GIS switchgear (8 bays)', '33 kV AIS switchgear panel line-up', '220 kV GIS switchgear (5 bays)', '11 kV metal-clad switchgear'],
    days: { SPEC: 12, RFQ: 20, BIDEVAL: 10, AWARD: 5, DWGSUB: 20, DWGAPP: 10, RAWMAT: 25, MFG: 60, FAT: 5, RELEASE: 4, SHIP: 26, CUSTOMS: 5, DELIVER: 4 },
  },
  {
    type: 'Chiller',
    count: 9,
    names: ['1,000 TR water-cooled centrifugal chiller', '500 TR air-cooled screw chiller', '1,500 TR centrifugal chiller', '300 TR magnetic-bearing chiller'],
    days: { SPEC: 10, RFQ: 15, BIDEVAL: 8, AWARD: 4, DWGSUB: 15, DWGAPP: 8, RAWMAT: 20, MFG: 45, FAT: 3, RELEASE: 4, SHIP: 25, CUSTOMS: 5, DELIVER: 4 },
  },
  {
    type: 'Diesel generator',
    count: 8,
    names: ['2,000 kVA standby diesel generator set', '1,250 kVA prime diesel generator set', '3,000 kVA containerised generator set', '800 kVA standby generator set'],
    days: { SPEC: 10, RFQ: 15, BIDEVAL: 8, AWARD: 4, DWGSUB: 15, DWGAPP: 8, RAWMAT: 20, MFG: 50, FAT: 4, RELEASE: 4, SHIP: 28, CUSTOMS: 5, DELIVER: 4 },
  },
  {
    type: 'Elevator',
    count: 6,
    names: ['Passenger elevators, 4 cars, 1,600 kg', 'Service elevator, 2,500 kg', 'High-rise passenger elevators, 6 cars', 'Bed/stretcher elevators, 2 cars'],
    days: { SPEC: 12, RFQ: 18, BIDEVAL: 10, AWARD: 5, DWGSUB: 20, DWGAPP: 12, RAWMAT: 25, MFG: 55, FAT: 3, RELEASE: 4, SHIP: 26, CUSTOMS: 5, DELIVER: 4 },
  },
]
const REGIONS = ['Middle East', 'South Asia', 'Europe', 'Southeast Asia', 'Domestic']
const VENDORS = ['Vendor A', 'Vendor B', 'Vendor C', 'Vendor D', 'Vendor E']

// ---- Deterministic randomness ------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = mulberry32(20261114)
const pick = (xs) => xs[Math.floor(rand() * xs.length)]
/** Standard normal (Box-Muller). */
const normal = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand())

/** A plausible actual duration around a typical one: log-normal spread plus occasional delays. */
function actualDays(code, typical) {
  const spread = ['MFG', 'RAWMAT', 'SHIP', 'DWGAPP'].includes(code) ? 0.25 : 0.18
  let d = typical * Math.exp(normal() * spread)
  // Manufacturing, material and drawing approval are where long-lead items usually slip.
  if (['MFG', 'RAWMAT', 'DWGAPP'].includes(code) && rand() < 0.15) d *= 1.3 + rand() * 0.3
  // Keep every figure within 0.6x to 1.8x of the typical duration.
  return Math.max(1, Math.round(Math.min(Math.max(d, typical * 0.6), typical * 1.8)))
}

// ---- Dates (Monday to Friday working days) -------------------------------------------------
const DAY = 86_400_000
const iso = (t) => new Date(t).toISOString().slice(0, 10)
const isWorkday = (t) => ![0, 6].includes(new Date(t).getUTCDay())
function addWorkdays(t, n) {
  while (!isWorkday(t)) t += DAY
  for (let i = 0; i < n; ) {
    t += DAY
    if (isWorkday(t)) i++
  }
  return t
}

/** Forward pass over the catalog (working-day offsets) given durations; returns the target's finish. */
function finishOffset(durations) {
  const start = {}
  const finish = {}
  for (const [code, , , , links] of CATALOG) {
    const d = durations[code] ?? 0
    let s = 0
    for (const [from, type, lag] of links) {
      if (type === 'FS') s = Math.max(s, finish[from] + lag)
      else if (type === 'SS') s = Math.max(s, start[from] + lag)
    }
    start[code] = s
    finish[code] = s + d
  }
  return finish[TARGET]
}

// ---- SQL -------------------------------------------------------------------------------
const q = (v) => (v === null || v === undefined ? 'null' : typeof v === 'number' ? String(v) : `'${String(v).replaceAll("'", "''")}'`)
const uuid = (n) => `5a3e0000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

function generate() {
  const out = []
  out.push(`-- GENERATED by scripts/gen-lle-sample.mjs; do not edit by hand (run \`node scripts/gen-lle-sample.mjs\`).
--
-- The 'lle-procurement' schedule type (procurement of long-lead equipment), its activity catalog,
-- and SAMPLE historical projects for the AI master planner.
--
-- The history below is REPRESENTATIVE SAMPLE DATA, NOT REAL PROJECT HISTORY: typical working-day
-- durations for long-lead equipment, varied with a seeded random generator. Every project is
-- is_sample = true, so the planner tells the user its numbers rest on samples. Load the company's
-- own completed projects, then remove the samples:
--   delete from history_projects where is_sample;
-- Vendors are placeholders ('Vendor A'...), not real companies.
`)
  out.push(`insert into schedule_types (id, name, description) values
  (${q(TYPE)}, 'Long-lead equipment procurement', 'From specification to equipment on site: tender, award, vendor drawings, manufacturing, testing, shipping and delivery.');
`)
  const rows = CATALOG.map(([code, name, phase, days, links], i) => {
    const json = JSON.stringify(links.map(([from, type, lagDays]) => ({ from, type, lagDays })))
    return `  (${q(TYPE)}, ${q(code)}, ${q(name)}, ${q(phase)}, ${i + 1}, ${q(json)}, ${days}, ${code === TARGET})`
  })
  out.push(`insert into activity_catalog (schedule_type, code, name, phase, sequence, default_links, default_days, is_target) values
${rows.join(',\n')};
`)

  let n = 0
  const projects = []
  const activities = []
  for (const eq of EQUIPMENT) {
    for (let k = 0; k < eq.count; k++) {
      const id = uuid(++n)
      const region = pick(REGIONS)
      const vendor = pick(VENDORS)
      // Purchase orders between 2019 and 2024.
      const po = addWorkdays(Date.UTC(2019, 0, 1) + Math.floor(rand() * 6 * 365) * DAY, 0)
      const actual = {}
      const planned = {}
      for (const [code] of CATALOG) {
        if (code === TARGET) continue
        // Domestic supply needs no customs clearance; some elevator contracts have no witnessed FAT.
        if (code === 'CUSTOMS' && region === 'Domestic') continue
        if (code === 'FAT' && eq.type === 'Elevator' && rand() < 0.5) continue
        const typical = eq.days[code]
        actual[code] = actualDays(code, typical)
        // Plans tend to be optimistic: 80-100% of the typical duration.
        planned[code] = Math.max(1, Math.round(typical * (0.8 + rand() * 0.2)))
      }
      // The PO is the award; dates after it follow the post-award part of the network.
      const awardOffset = (d) => {
        const zeroPreAward = { ...d, SPEC: 0, RFQ: 0, BIDEVAL: 0, AWARD: 0 }
        return finishOffset(zeroPreAward)
      }
      projects.push(
        `  (${q(id)}, ${q(TYPE)}, ${q(eq.type)}, ${q(pick(eq.names))}, ${q(region)}, ${q(vendor)}, ${q(iso(po))}, ` +
          `${q(iso(addWorkdays(po, awardOffset(planned))))}, ${q(iso(addWorkdays(po, awardOffset(actual))))}, ${q(SAMPLE_NOTE)}, true)`,
      )
      for (const [code] of CATALOG) {
        if (actual[code] === undefined) continue
        activities.push(`  (${q(id)}, ${q(TYPE)}, ${q(code)}, ${actual[code]}, ${planned[code]})`)
      }
    }
  }
  out.push(`insert into history_projects (id, schedule_type, equipment_type, equipment_name, region, vendor, po_date, required_on_site, actual_on_site, notes, is_sample) values
${projects.join(',\n')};
`)
  out.push(`insert into history_activities (project_id, schedule_type, code, actual_days, planned_days) values
${activities.join(',\n')};
`)
  return out.join('\n')
}

const sql = generate()
if (process.argv.includes('--check')) {
  let current = ''
  try {
    current = readFileSync(OUT, 'utf8')
  } catch {
    // missing: out of date
  }
  if (current !== sql) {
    console.error(`${path.relative(process.cwd(), OUT)} is out of date: run node scripts/gen-lle-sample.mjs`)
    process.exit(1)
  }
} else {
  writeFileSync(OUT, sql)
  console.log(`wrote ${path.relative(process.cwd(), OUT)}`)
}
