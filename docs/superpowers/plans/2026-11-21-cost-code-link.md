# Cost code on Plan with AI items: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user give each Plan with AI item a Procore cost code (auto-filled from the equipment type, editable) and carry it into a strict Cost code dropdown column on the generated sheet.

**Architecture:** A read-only `cost_codes` reference table (15 Procore codes, 5 flagged `in_planner`) is read by the existing planner options loader and returned as `PlannerOptions.costCodes`. The wizard keeps `costCode` / `costCodeEdited` on each form item and keeps unedited codes in step with the item's type through one pure function. At Create, the wizard hands the sheet builder the dropdown options and each item's option text, looked up by item key. Nothing goes to the AI or to Procore.

**Tech Stack:** TypeScript, React 18, Vitest + Testing Library, PGlite migration tests, Supabase (Postgres), Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-11-21-cost-code-link-design.md`

## Global Constraints

- Codes and descriptions are copied exactly from Procore, typos included: `CLT` = `Colling Tower`, `HVS` = `HV SiwtchGear`.
- Exactly five codes have `in_planner = true`: `CHL`→`Chiller`, `GEN`→`Diesel generator`, `ELE`→`Elevator`, `HVS`→`HV switchgear`, `TRF`→`Power transformer`. Those equipment type strings match `history_projects.equipment_type` exactly.
- Option text is `` `${code} — ${description}` `` (space, em dash U+2014, space), e.g. `GEN — Generator`. Option text must contain no comma.
- The column title is `Cost code`, type `PICKLIST`, placed immediately before `Basis`.
- The cost code is optional, never blocks Generate, is never sent to `/api/planner/*`, and a failed cost-code load never blocks planning.
- Several items: the code goes on the item's summary (parent) row only. One item (flat sheet): on every row.
- No Procore calls, no sync button, no other codes in the dropdown.

## Review Focus

1. **Switching schedule type** (the effect at `src/planner/PlannerWizard.tsx:181` resets item types): an unedited code must follow the new type, and an edited one must stay. Pinned in Task 3 (`syncCostCodes`) and Task 5 (wizard test).
2. **Options without `costCodes`** (query failed, or an older server): the field is hidden, Generate works, and the sheet has no Cost code column. Pinned in Tasks 2, 4 and 5.
3. **Changing only the cost code after generating** (Back to the request, change the code, return to the preview, Create without regenerating): the sheet uses the latest code. Pinned in Task 5 because Create reads codes from form items, not from the Job.
4. **A "type it yourself" item whose text equals a mapped type** (typed "Chiller"): stays blank, per the spec. Pinned in Task 3.
5. **A stored code that is no longer on offer** (e.g. its flag removed while the wizard is open): the cell is left empty rather than given a value the strict dropdown would reject. Pinned in Task 4 (`buildSheetFromDrafts` ignores values not in `options`).

---

### Task 1: `cost_codes` table and seed

**Files:**
- Create: `supabase/migrations/0019_cost_codes.sql`
- Test: `src/db/costCodes.test.ts`

**Interfaces:**
- Produces: table `cost_codes(code text primary key, description text not null, in_planner boolean not null default false, equipment_type text null unique)`, readable by `authenticated`, no access for `anon`, no writes through the API.

- [ ] **Step 1: Write the failing test** (`// @vitest-environment node`, same setup as `src/db/projectTypes.test.ts`: `createSupabaseLikeDb()`, `roles(db)`, 30 s timeouts)

```ts
describe('0019_cost_codes', () => {
  it('seeds the 15 Procore cost codes exactly', async () => {
    await as.asUser(USER)
    const r = await db.query<{ code: string; description: string }>(`select code, description from cost_codes order by code`)
    expect(r.rows).toEqual([
      { code: 'ADV', description: 'Advance Payment' },
      { code: 'ADV-REC', description: 'Advance Payment Recovery' },
      { code: 'AUH', description: 'Authority' },
      { code: 'CHL', description: 'Chiller' },
      { code: 'CLT', description: 'Colling Tower' },
      { code: 'CONS', description: 'Consultancy Fees' },
      { code: 'CRAC', description: 'CRAC/CRAH/FWU' },
      { code: 'CSA', description: 'Civil & Structural' },
      { code: 'DU', description: 'Coolant & Distribution Unit' },
      { code: 'ELE', description: 'Elevator' },
      { code: 'GEN', description: 'Generator' },
      { code: 'HVS', description: 'HV SiwtchGear' },
      { code: 'POW', description: 'Power Skid' },
      { code: 'TRF', description: 'Transformer' },
      { code: 'UPS', description: 'UPS & Battery System' },
    ])
  })

  it('offers exactly the five MVP codes to the planner, each mapped to an equipment type', async () => {
    await as.asUser(USER)
    const r = await db.query(`select code, equipment_type from cost_codes where in_planner order by code`)
    expect(r.rows).toEqual([
      { code: 'CHL', equipment_type: 'Chiller' },
      { code: 'ELE', equipment_type: 'Elevator' },
      { code: 'GEN', equipment_type: 'Diesel generator' },
      { code: 'HVS', equipment_type: 'HV switchgear' },
      { code: 'TRF', equipment_type: 'Power transformer' },
    ])
  })

  it('maps only to equipment types the planner has history for', async () => {
    await as.asUser(USER)
    const r = await db.query(
      `select equipment_type from cost_codes where equipment_type is not null
       except select equipment_type from planner_equipment_types`,
    )
    expect(r.rows).toEqual([])
  })

  it('rejects a description with a comma (dropdown options cannot hold one)', async () => {
    await expect(db.query(`insert into cost_codes (code, description) values ('X', 'A, B')`)).rejects.toThrow()
  })

  it('is read-only for users and closed to anon', async () => {
    await as.asUser(USER)
    await expect(db.query(`insert into cost_codes (code, description) values ('X', 'X')`)).rejects.toThrow()
    await expect(db.query(`update cost_codes set in_planner = true where code = 'UPS'`)).resolves.toMatchObject({ affectedRows: 0 })
    await as.asAnon()
    await expect(db.query(`select * from cost_codes`)).rejects.toThrow()
  })
})
```

(The comma test runs as the migration owner, before any `as.*` switch, or after `as.asService()` if `roles` has one. Check `src/db/supabaseTestDb.ts` and use whichever role can insert. If an update with no grant throws in PGlite rather than affecting 0 rows, assert `rejects.toThrow()` instead.)

- [ ] **Step 2: Run it and check it fails**

Run: `npx vitest run src/db/costCodes.test.ts`
Expected: FAIL, `relation "cost_codes" does not exist`.

- [ ] **Step 3: Write `supabase/migrations/0019_cost_codes.sql`**

Header comment: what the table is (Procore cost codes, copied exactly, typos included), that `in_planner` picks what the wizard offers, that `equipment_type` drives auto-fill, and that changing the offer is a new migration. Follow the 0011 pattern: `enable row level security`, `create policy cost_codes_read ... for select to authenticated using (true)`, `revoke all ... from anon, public`, `grant select ... to authenticated`. Checks: `code ~ '^[A-Z0-9][A-Z0-9-]*$'`, `length(trim(description)) > 0`, `position(',' in description) = 0`. Seed the 15 rows from the test, with `in_planner` and `equipment_type` set for the five.

- [ ] **Step 4: Run it and check it passes**

Run: `npx vitest run src/db/costCodes.test.ts src/db/rls.test.ts`
Expected: PASS. Any RLS test that lists every table must still pass, so add `cost_codes` to that list if it has one.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0019_cost_codes.sql src/db/costCodes.test.ts
git commit -m "Cost codes: Procore cost code table, five offered to Plan with AI"
```

---

### Task 2: Cost codes in the planner options, and the helpers

**Files:**
- Modify: `src/planner/types.ts` (add `CostCode`; add `costCodes?` to `PlannerOptions`)
- Modify: `src/planner/history.ts` (`options()` reads `cost_codes`)
- Create: `src/planner/costCodes.ts`
- Test: `src/planner/history.test.ts`, `src/planner/costCodes.test.ts`

**Interfaces:**
- Consumes: `cost_codes` (Task 1).
- Produces:
  - `export interface CostCode { code: string; description: string; equipmentType: string | null }` in `types.ts`
  - `PlannerOptions.costCodes?: CostCode[]`: only `in_planner` rows, ordered by `code`. **Absent** when the query fails or returns no rows.
  - `costCodes.ts`:
    - `costCodeOption(c: CostCode): string`, e.g. `'GEN — Generator'`
    - `codeForType(codes: readonly CostCode[], equipmentType: string): string`: the code mapped to that exact type, else `''`
    - `optionForCode(codes: readonly CostCode[], code: string): string | undefined`

- [ ] **Step 1: Write the failing tests**

In `history.test.ts > options`:
- Extend the first test's fake client with `cost_codes: ok([{ code: 'CHL', description: 'Chiller', equipment_type: 'Chiller' }, { code: 'GEN', description: 'Generator', equipment_type: 'Diesel generator' }])`. Expect `costCodes: [{ code: 'CHL', description: 'Chiller', equipmentType: 'Chiller' }, { code: 'GEN', description: 'Generator', equipmentType: 'Diesel generator' }]` in the result, and `'cost_codes'` in the sorted list of select targets.
- New test `'leaves costCodes out when the cost code query fails, and still returns the options'`: `cost_codes: { data: null, error: { message: 'permission denied for table cost_codes' } }`. Expect `options.costCodes` to be `undefined` and `options.scheduleTypes` to be filled. Also check that `ok([])` gives `undefined`.
- Record (in the fake client's `calls`, if it records filters) that the query filters `in_planner = true`. If it doesn't record filters, rely on Task 1's data test.

In `costCodes.test.ts`:

```ts
const CODES: CostCode[] = [
  { code: 'CHL', description: 'Chiller', equipmentType: 'Chiller' },
  { code: 'HVS', description: 'HV SiwtchGear', equipmentType: 'HV switchgear' },
  { code: 'X', description: 'Unmapped', equipmentType: null },
]
it('formats an option as code, em dash, description', () => {
  expect(costCodeOption(CODES[1])).toBe('HVS — HV SiwtchGear')
})
it('finds the code for an exact equipment type, else empty', () => {
  expect(codeForType(CODES, 'HV switchgear')).toBe('HVS')
  expect(codeForType(CODES, 'hv switchgear')).toBe('')
  expect(codeForType(CODES, 'Crane')).toBe('')
  expect(codeForType(CODES, '')).toBe('')
})
it('finds the option text for a code, undefined when not offered', () => {
  expect(optionForCode(CODES, 'CHL')).toBe('CHL — Chiller')
  expect(optionForCode(CODES, 'UPS')).toBeUndefined()
  expect(optionForCode(CODES, '')).toBeUndefined()
})
```

- [ ] **Step 2: Run them and check they fail**

Run: `npx vitest run src/planner/history.test.ts src/planner/costCodes.test.ts`
Expected: FAIL. `costCodes.ts` does not exist yet, and `options()` has no `costCodes`.

- [ ] **Step 3: Implement**

In `history.ts`, add a fourth query to the `Promise.all`: `client.from('cost_codes').select('code, description, equipment_type').eq('in_planner', true).order('code', { ascending: true })`. Do **not** pass it through `rows()` (which throws). Read `{ data, error }` directly and include `costCodes` only when there is no error and at least one row. Add `'cost_codes'` to the fake client in `history.test.ts`, and to `e2e/support/fakeSupabase.ts` if its `from()` throws on unknown tables. Write `costCodes.ts` with the three functions.

- [ ] **Step 4: Run them and check they pass**

Run: `npx vitest run src/planner/history.test.ts src/planner/costCodes.test.ts server/app.test.ts`
Expected: PASS. `server/app.test.ts` must stay green: `/api/planner/options` returns `source.options()` unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/planner/types.ts src/planner/history.ts src/planner/costCodes.ts src/planner/history.test.ts src/planner/costCodes.test.ts
git commit -m "Plan with AI: offer the planner's cost codes with the options"
```

---

### Task 3: Cost code on the form item (auto-fill, edited flag)

**Files:**
- Modify: `src/planner/plannerItems.ts`
- Test: `src/planner/plannerItems.test.ts`

**Interfaces:**
- Consumes: nothing from Task 2 directly. Takes a `codeFor` function, so this file stays free of `CostCode`.
- Produces:
  - `ItemForm` gains `costCode: string` (a code like `'GEN'`, or `''`) and `costCodeEdited: boolean`. `newItem` sets them to `''` and `false`.
  - `syncCostCodes(items: ItemForm[], codeFor: (equipmentType: string) => string): ItemForm[]`. For each item with `costCodeEdited === false`, it sets `costCode` to `item.choice === OTHER ? '' : codeFor(item.choice)`. It returns **the same array** when nothing changed (the wizard's effects compare by reference).
  - `setCostCode(item: ItemForm, code: string): ItemForm` returns `{ ...item, costCode: code, costCodeEdited: true }`. Clearing to `''` also counts as edited.
  - `jobFromForm` is **unchanged**: the cost code is not part of the Job and is never sent.

- [ ] **Step 1: Write the failing tests**

```ts
const codeFor = (t: string) => ({ Chiller: 'CHL', 'Diesel generator': 'GEN' })[t] ?? ''

it('fills an unedited item’s code from its type', () => {
  const [a] = syncCostCodes([newItem('Chiller')], codeFor)
  expect(a.costCode).toBe('CHL')
})
it('follows a type change while the code is unedited', () => {
  const items = syncCostCodes([newItem('Chiller')], codeFor)
  const [b] = syncCostCodes([{ ...items[0], choice: 'Diesel generator' }], codeFor)
  expect(b.costCode).toBe('GEN')
})
it('clears the code when the new type has none', () => {
  const items = syncCostCodes([newItem('Chiller')], codeFor)
  expect(syncCostCodes([{ ...items[0], choice: 'Crane' }], codeFor)[0].costCode).toBe('')
})
it('keeps a hand-picked code when the type changes', () => {
  const edited = setCostCode(newItem('Chiller'), 'GEN')
  expect(syncCostCodes([{ ...edited, choice: 'Chiller' }], codeFor)[0].costCode).toBe('GEN')
})
it('keeps a hand-cleared code empty when the type changes', () => {
  const cleared = setCostCode(syncCostCodes([newItem('Chiller')], codeFor)[0], '')
  expect(syncCostCodes([{ ...cleared, choice: 'Diesel generator' }], codeFor)[0].costCode).toBe('')
})
it('leaves a typed-in type blank even when the text matches a mapped type', () => {
  const other = { ...newItem(OTHER), other: 'Chiller' }
  expect(syncCostCodes([other], codeFor)[0].costCode).toBe('')
})
it('returns the same array when nothing changes', () => {
  const items = syncCostCodes([newItem('Chiller')], codeFor)
  expect(syncCostCodes(items, codeFor)).toBe(items)
})
it('does not put the cost code in the job', () => {
  const item = { ...setCostCode(newItem('Chiller'), 'CHL'), name: 'Chiller 1', date: '2027-11-17' }
  const job = jobFromForm({ scheduleType: 'lle-procurement', items: [item], sameDate: false, sharedDate: '', notes: '' })
  expect(job.items[0]).not.toHaveProperty('costCode')
})
```

- [ ] **Step 2: Run them and check they fail**

Run: `npx vitest run src/planner/plannerItems.test.ts`
Expected: FAIL, `syncCostCodes is not a function`.

- [ ] **Step 3: Implement** the two fields and the two functions in `plannerItems.ts`. Leave `isPristine` unchanged: an auto-filled code alone doesn't make an item touched.

- [ ] **Step 4: Run them and check they pass**

Run: `npx vitest run src/planner/plannerItems.test.ts src/planner/plannerEntries.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/planner/plannerItems.ts src/planner/plannerItems.test.ts
git commit -m "Plan with AI: cost code on each item, following its type until edited"
```

---

### Task 4: Cost code column on the generated sheet

**Files:**
- Modify: `src/planner/sheetFromDraft.ts`
- Test: `src/planner/sheetFromDraft.test.ts`

**Interfaces:**
- Produces:
  - `export const COST_CODE_COLUMN_TITLE = 'Cost code'`
  - `export interface CostCodeColumn { options: string[]; values: (string | undefined)[] }`. `values[i]` is the option text for draft `i`, in draft order.
  - `buildSheetFromDraft(draft, plan, ownerId, calendar, costCodes?: CostCodeColumn)`
  - `buildSheetFromDrafts(items, ownerId, calendar, costCodes?: CostCodeColumn)`
  - `insertSheetFromDrafts(client, drafts, userId, calendar, options: { today?: string; costCodes?: CostCodeColumn } = {})`
- Rules: the column is added only when `costCodes` is given **and** `costCodes.options.length > 0`. It is `{ type: 'PICKLIST', title: 'Cost code', options }`, placed immediately before Basis. A value is written only if `options.includes(value)`. Several items: the value goes on the summary row only. One item: on every activity row.

- [ ] **Step 1: Write the failing tests** (reuse the file's existing drafts and fixtures)

```ts
const CC: CostCodeColumn = { options: ['CHL — Chiller', 'GEN — Generator'], values: ['GEN — Generator', undefined] }

it('adds a strict Cost code dropdown just before Basis', () => {
  const { columns } = buildSheetFromDrafts(twoItems, OWNER, calendar, CC)
  const i = columns.findIndex((c) => c.title === 'Cost code')
  expect(columns[i]).toMatchObject({ type: 'PICKLIST', options: ['CHL — Chiller', 'GEN — Generator'] })
  expect(columns[i + 1].title).toBe('Basis')
})
it('puts each item’s code on its summary row only', () => {
  const { columns, rows } = buildSheetFromDrafts(twoItems, OWNER, calendar, CC)
  const col = columns.find((c) => c.title === 'Cost code')!.id
  const parents = rows.filter((r) => r.parentId === null)
  expect(parents.map((r) => r.cells[col])).toEqual(['GEN — Generator', undefined])
  expect(rows.filter((r) => r.parentId !== null).every((r) => r.cells[col] === undefined)).toBe(true)
})
it('puts a single item’s code on every row', () => {
  const { columns, rows } = buildSheetFromDrafts(oneItem, OWNER, calendar, { options: CC.options, values: ['CHL — Chiller'] })
  const col = columns.find((c) => c.title === 'Cost code')!.id
  expect(rows.every((r) => r.cells[col] === 'CHL — Chiller')).toBe(true)
})
it('ignores a value that is not one of the options', () => {
  const { columns, rows } = buildSheetFromDrafts(oneItem, OWNER, calendar, { options: CC.options, values: ['UPS — UPS & Battery System'] })
  const col = columns.find((c) => c.title === 'Cost code')!.id
  expect(rows.every((r) => r.cells[col] === undefined)).toBe(true)
})
it('adds no column without cost codes or with no options', () => {
  expect(buildSheetFromDrafts(twoItems, OWNER, calendar).columns.some((c) => c.title === 'Cost code')).toBe(false)
  expect(buildSheetFromDrafts(twoItems, OWNER, calendar, { options: [], values: [] }).columns.some((c) => c.title === 'Cost code')).toBe(false)
})
```

Also add one `insertSheetFromDrafts` test against the fake client already used in this file (or `createFakeSupabase`): the saved `columns` include the PICKLIST with its options, and the saved parent row carries the value.

- [ ] **Step 2: Run them and check they fail**

Run: `npx vitest run src/planner/sheetFromDraft.test.ts`
Expected: FAIL. `CostCodeColumn` is not exported and no Cost code column is created.

- [ ] **Step 3: Implement.** `newPlanSheet` takes `costCodeOptions?: string[]` and inserts the column before `basisColumn`; add `costCode?: string` to `cols`. `buildSheetFromDrafts` writes `values[i]` on summary row `i`. The single-item path (`buildSheetFromDraft`, which `buildSheetFromDrafts` delegates to) passes `values[0]` into `activityRows`, which writes it on every row. `insertSheetFromDrafts` forwards `options.costCodes`. Check that `columnToDb` in `src/store/persistence.ts` already persists `options`. It does for user-made dropdowns; if not, persist it.

- [ ] **Step 4: Run them and check they pass**

Run: `npx vitest run src/planner/sheetFromDraft.test.ts src/planner/plannerChain.integration.test.ts`
Expected: PASS. Existing tests that count columns or check the last column is Basis must still pass, since without cost codes nothing changes.

- [ ] **Step 5: Commit**

```bash
git add src/planner/sheetFromDraft.ts src/planner/sheetFromDraft.test.ts
git commit -m "Plan with AI: Cost code dropdown column on the generated sheet"
```

---

### Task 5: The wizard field, and Create passing the codes

**Files:**
- Modify: `src/planner/PlannerWizard.tsx`, `src/planner/plannerWizard.css`
- Test: `src/planner/PlannerWizard.test.tsx`, `e2e/planner.spec.ts`

**Interfaces:**
- Consumes: `options.costCodes`, `costCodeOption`, `codeForType`, `optionForCode` (Task 2); `syncCostCodes`, `setCostCode` (Task 3); `insertSheetFromDrafts(..., { today, costCodes })` (Task 4).
- Behaviour:
  - `const costCodes = options?.costCodes ?? []`. The field is shown only when `costCodes.length > 0`.
  - Add an effect beside the one at line 181: `setItems((prev) => syncCostCodes(prev, (t) => codeForType(costCodes, t)))`, depending on `[items, options]`. It is a no-op when nothing changes, because the same array is returned.
  - `ItemFields` gets a fourth field after Required on site: a `<label>`led `<select>` with label text **Cost code**, an empty first option labelled **None**, then one `<option value={c.code}>{costCodeOption(c)}</option>` per code. `onChange` → `setCostCode(item, e.target.value)`. Follow the existing field pattern (ids from `idBase`, e.g. `${idBase}-cost-code`) so labels and tests find it by role and name.
  - `create()`: build `costCodes` for the sheet only when the list is non-empty: `{ options: costCodes.map(costCodeOption), values: entries.map((e) => optionForCode(costCodes, items.find((i) => i.key === e.key)?.costCode ?? '')) }`. Read from the **current form items**, not the Job (see Review Focus 3).

- [ ] **Step 1: Write the failing tests** in `PlannerWizard.test.tsx`

Extend `OPTIONS` with `costCodes: [{ code: 'TRF', description: 'Transformer', equipmentType: 'Power transformer' }, { code: 'HVS', description: 'HV SiwtchGear', equipmentType: 'Switchgear' }]`. (The fixture's type is `Switchgear`; the mapping follows the fixture.) Then:

- `'fills the cost code from the equipment type and follows a type change'`: the Cost code select shows `TRF`. Change the type to Switchgear → `HVS`.
- `'keeps a hand-picked cost code when the type changes'`: pick None, change the type → still None.
- `'keeps an unedited code in step when the schedule type changes the item’s type'`: use a second schedule type in a local OPTIONS whose first type is `Switchgear`.
- `'does not send the cost code to the planning server'`: after Generate, `JSON.stringify(batches[0])` (or `drafts[0]`) does not contain `costCode`, `TRF` or `HVS`.
- `'creates the sheet with the cost code column and each item’s code'`: generate two items, Create, then read the fake Supabase state. The columns include `Cost code` with options `['TRF — Transformer', 'HVS — HV SiwtchGear']`, and the parent rows carry the chosen options.
- `'uses a cost code changed after generating, without regenerating'`: Generate, go Back to the request, change one code, return to the preview, Create → the new code is in the sheet. Skip this test with a note if the wizard has no Back-to-preview path without regenerating. In that case Review Focus 3 cannot happen.
- `'hides the field and adds no column when the options have no cost codes'`: use the default OPTIONS without `costCodes` → no element with the name Cost code, Create works, and the sheet has no `Cost code` column.

- [ ] **Step 2: Run them and check they fail**

Run: `npx vitest run src/planner/PlannerWizard.test.tsx`
Expected: FAIL, no Cost code field.

- [ ] **Step 3: Implement** as in the Behaviour list. In `plannerWizard.css`, give the item row grid a fourth column so the row still fits at the dialog's width. At narrow widths it wraps the same way the date field does today.

- [ ] **Step 4: Run them and check they pass**

Run: `npx vitest run src/planner`
Expected: PASS (all planner tests).

- [ ] **Step 5: Add an e2e check** in `e2e/planner.spec.ts`. In the multi-item test (the one routing `**/api/planner/draft-batch`), add `costCodes` to its OPTIONS, check that the Cost code select shows the auto-filled option, Create, and check that the grid shows a `Cost code` column header and the option text on the item's summary row.

Run: `npm run test:e2e -- e2e/planner.spec.ts --trace off`
Expected: PASS.

- [ ] **Step 6: Full check, then commit**

Run: `npm test && npx tsc -b`
Expected: all tests pass, no type errors.

```bash
git add src/planner/PlannerWizard.tsx src/planner/plannerWizard.css src/planner/PlannerWizard.test.tsx e2e/planner.spec.ts
git commit -m "Plan with AI: pick a cost code per item; the sheet gets it"
```

---

## Not in this plan (per spec)
Procore API or sync, PO number and commitment data, export upload, cost types, per-project lists,
an admin screen, the other 10 codes in the dropdown. The spec's `codeFromOption` parser is left for
the phase 2 sync that needs it (YAGNI).
