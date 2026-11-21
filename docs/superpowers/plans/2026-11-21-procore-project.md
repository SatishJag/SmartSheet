# Procore project on the plan: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user choose one Procore project per Plan with AI request, carried into a strict "Procore project" dropdown column next to Cost code on the generated sheet.

**Architecture:** This mirrors the cost code feature that is already built (`docs/superpowers/plans/2026-11-21-cost-code-link.md`). A read-only `procore_projects` table is returned as `PlannerOptions.procoreProjects`. The wizard keeps one `procoreProject` code in state. At Create, the sheet builder gets the dropdown options and the chosen option text, and writes it on the same rows as the cost code.

**Tech Stack:** TypeScript, React 18, Vitest + Testing Library, PGlite migration tests, Supabase (Postgres), Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-11-21-cost-code-link-design.md`, section "Addendum: Procore project on the plan".

## Global Constraints

- Seed exactly one project: `code = 'BKK-03'`, `name = 'Bangkok 3'`, `is_program = false`, `in_planner = true`. No placeholder program project.
- Option text is `` `${code} — ${name}` `` (space, em dash U+2014, space), e.g. `BKK-03 — Bangkok 3`. Names contain no comma.
- Order: program projects first, then by code.
- The wizard field is labelled **Procore project**, sits right after **Schedule type**, starts on **None**, never pre-selects, is optional, and is hidden when the list is empty or failed to load.
- The sheet column title is **`Procore project`**, type `PICKLIST`, placed immediately before `Cost code`, or before `Basis` when there is no Cost code column. It is added whenever the list loaded, even with None chosen.
- Rows: every summary row when there are several items, every row when there is one. A value not among the options is left empty.
- The project is never sent to `/api/planner/*`. No Procore calls.
- `ids.project` in `PlannerWizard.tsx` already means the project **type**; the new field uses `ids.procoreProject`.

## Review Focus

1. **One list loads and the other doesn't** (projects without cost codes, or the reverse): each column appears on its own, in the right place. Pinned in Task 3.
2. **Switching project type or schedule type** keeps the chosen project. Pinned in Task 4.
3. **None chosen**: the column is still added and the cells are empty. Pinned in Task 3.
4. **A value not among the options** is left empty. Pinned in Task 3.
5. **Leak to the server**: the batch and draft bodies don't contain the project code. Pinned in Task 4.

---

### Task 1: `procore_projects` table and seed

**Files:**
- Create: `supabase/migrations/0020_procore_projects.sql`
- Test: `src/db/procoreProjects.test.ts`

**Interfaces:**
- Produces: `procore_projects(code text primary key, name text not null, is_program boolean not null default false, in_planner boolean not null default true)`. Grants are exactly as in `0019_cost_codes.sql`: `revoke all ... from anon, authenticated, public; grant select ... to authenticated`, with RLS read policy `procore_projects_read`.

- [ ] **Step 1: Write the failing test.** Use the same setup as `src/db/costCodes.test.ts`, with these tests:
  - `'seeds BKK-03 Bangkok 3 as the only project, a site offered to the planner'`: `select code, name, is_program, in_planner from procore_projects` equals `[{ code: 'BKK-03', name: 'Bangkok 3', is_program: false, in_planner: true }]`.
  - `'rejects a name with a comma'`: as superuser, inserting `('X', 'A, B')` rejects.
  - `'rejects a malformed code'`: as superuser, inserting `('bkk 03', 'X')` rejects. The check is `code ~ '^[A-Z0-9][A-Z0-9-]*$'`.
  - `'is read-only for users and closed to anon'`: insert and update reject as the user, and select rejects as anon.
- [ ] **Step 2: Run it and check it fails.** Run `npx vitest run src/db/procoreProjects.test.ts`. Expected: FAIL, `relation "procore_projects" does not exist`.
- [ ] **Step 3: Write the migration.** Header comment: why (a budget line is project + cost code; program-level buying), copied exactly from Procore, and the program project to be added later by a new migration with `is_program = true`. Checks: the code format, `length(trim(name)) > 0` and `position(',' in name) = 0`.
- [ ] **Step 4: Run it and check it passes.** Run `npx vitest run src/db/procoreProjects.test.ts src/db/costCodes.test.ts src/db/rls.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `Procore projects: table seeded with BKK-03, offered to Plan with AI`.

---

### Task 2: Projects in the planner options, and the helpers

**Files:**
- Modify: `src/planner/types.ts`, `src/planner/history.ts`
- Create: `src/planner/procoreProjects.ts`
- Test: `src/planner/history.test.ts`, `src/planner/procoreProjects.test.ts`

**Interfaces:**
- Produces:
  - `export interface ProcoreProject { code: string; name: string; isProgram: boolean }` in `types.ts`
  - `PlannerOptions.procoreProjects?: ProcoreProject[]`: `in_planner` rows ordered by `is_program` descending, then `code`. Absent on error or when empty, exactly like `costCodes`.
  - `procoreProjects.ts`:
    - `projectOption(p: ProcoreProject): string`, e.g. `'BKK-03 — Bangkok 3'`
    - `optionForProject(projects: readonly ProcoreProject[], code: string): string | undefined`

- [ ] **Step 1: Write the failing tests.**
  - In `history.test.ts`, the first `options` test adds `procore_projects: ok([{ code: 'PRG-1', name: 'Programme', is_program: true }, { code: 'BKK-03', name: 'Bangkok 3', is_program: false }])`. Expect `procoreProjects: [{ code: 'PRG-1', name: 'Programme', isProgram: true }, { code: 'BKK-03', name: 'Bangkok 3', isProgram: false }]` (row order preserved). Add `'procore_projects'` to the sorted select targets. Expect calls to include `eq('in_planner', true)`, `order('is_program', { ascending: false })` and `order('code', { ascending: true })` on `procore_projects`.
  - Extend the "leaves costCodes out…" test, or add a sibling, so that a failed or empty `procore_projects` gives `procoreProjects === undefined` while the other options still load.
  - `procoreProjects.test.ts`: `projectOption({ code: 'BKK-03', name: 'Bangkok 3', isProgram: false })` is `'BKK-03 — Bangkok 3'`. `optionForProject` returns that text for `'BKK-03'`, and `undefined` for `'XYZ'` and for `''`.
- [ ] **Step 2: Run them and check they fail.** Run `npx vitest run src/planner/history.test.ts src/planner/procoreProjects.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add a fifth query to the `Promise.all` in `options()`. Read `{ data, error }` directly, as the `costCodes` query does (not via `rows()`). Add a `ProcoreProjectRow` interface.
- [ ] **Step 4: Run them and check they pass.** Run `npx vitest run src/planner/history.test.ts src/planner/procoreProjects.test.ts server/app.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `Plan with AI: offer the Procore projects with the options`.

---

### Task 3: Procore project column on the generated sheet

**Files:**
- Modify: `src/planner/sheetFromDraft.ts`
- Test: `src/planner/sheetFromDraft.test.ts`

**Interfaces:**
- Consumes: the existing `CostCodeColumn` and `costCodeValue` row rule.
- Produces:
  - `export const PROJECT_COLUMN_TITLE = 'Procore project'`
  - `export interface ProjectColumn { options: string[]; value?: string }`, with one value for the whole plan
  - `buildSheetFromDraft(draft, plan, ownerId, calendar, costCodes?, project?: ProjectColumn)`
  - `buildSheetFromDrafts(items, ownerId, calendar, costCodes?, project?: ProjectColumn)`
  - `insertSheetFromDrafts(..., options: { today?: string; costCodes?: CostCodeColumn; project?: ProjectColumn })`
- Rules:
  - The column is added when `project?.options.length > 0`. It is `{ type: 'PICKLIST', title: 'Procore project', options }`, placed immediately before the Cost code column, or before Basis when there is none.
  - `value` is written only if `options.includes(value)`: on every summary row when there are several items, on every row when there is one.

- [ ] **Step 1: Write the failing tests** in a new `describe('Procore project column')`, reusing `threeDrafts()`, `lleDraft()` and `planBackward` as the Cost code tests do. With `P: ProjectColumn = { options: ['BKK-03 — Bangkok 3'], value: 'BKK-03 — Bangkok 3' }`:
  - `'adds a strict Procore project dropdown just before Cost code'`: with `CC` and `P`, the column order ends `…, 'Procore project', 'Cost code', 'Basis'`, and the new column is a `PICKLIST` with `P.options`.
  - `'goes just before Basis when there is no Cost code column'`: with `undefined` and `P`, the order ends `'Procore project', 'Basis'`.
  - `'puts the project on every summary row only'`: three items. All three summary rows hold `'BKK-03 — Bangkok 3'` and every child row is `undefined`.
  - `'puts a single item’s project on every row'`.
  - `'adds the column with empty cells when no project was chosen'`: `{ options: P.options }`. The column exists and every cell is `undefined`.
  - `'ignores a value that is not one of the options'`: `value: 'XYZ — Nowhere'`. Every cell is `undefined`.
  - `'adds no column without projects'`: `undefined`, and also `{ options: [] }`.
  - `'saves the column and the project, and they load back'`: through `insertSheetFromDrafts(..., { today: TODAY, costCodes: CC, project: P })` and `supabasePersistence(client).loadSheet`.
- [ ] **Step 2: Run them and check they fail.** Run `npx vitest run src/planner/sheetFromDraft.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `newPlanSheet` takes `projectOptions: string[] = []` after `costCodeOptions` and adds `cols.project`. `activityRows` takes a `project?: string`. In `buildSheetFromDrafts`, the summary row writes the project next to the cost code. Add a `projectValue(project)` helper alongside `costCodeValue`.
- [ ] **Step 4: Run them and check they pass.** Run `npx vitest run src/planner/sheetFromDraft.test.ts src/planner/plannerChain.integration.test.ts`. Expected: PASS, with all existing Cost code tests unchanged.
- [ ] **Step 5: Commit** with the message `Plan with AI: Procore project column on the generated sheet`.

---

### Task 4: The wizard field, and Create passing the project

**Files:**
- Modify: `src/planner/PlannerWizard.tsx`
- Test: `src/planner/PlannerWizard.test.tsx`, `e2e/planner.spec.ts`

**Interfaces:**
- Consumes: `options.procoreProjects`, `projectOption`, `optionForProject` (Task 2); `insertSheetFromDrafts(..., { project })` (Task 3).
- Behaviour:
  - `const procoreProjects = options?.procoreProjects ?? NO_PROJECTS` (a module constant, as `NO_COST_CODES` is).
  - State: `const [procoreProject, setProcoreProject] = useState('')`. It is not reset by `chooseProjectType` or `setScheduleType`.
  - Right after the Schedule type field, only when `procoreProjects.length > 0`: a `planner-field` with `<label htmlFor={ids.procoreProject}>Procore project</label>` and a `<select>` holding `<option value="">None</option>`, then one `<option value={p.code}>{projectOption(p)}</option>` per project. Add `procoreProject: useId()` to `ids`.
  - In `create()`: pass `project = procoreProjects.length > 0 ? { options: procoreProjects.map(projectOption), value: optionForProject(procoreProjects, procoreProject) } : undefined`.
  - Nothing is added to the `Job` or to the request bodies.

- [ ] **Step 1: Write the failing tests** in a new `describe('PlannerWizard: Procore project')`. Use `OPTIONS_P = { ...OPTIONS, procoreProjects: [{ code: 'BKK-03', name: 'Bangkok 3', isProgram: false }] }`, and add `costCodes` where needed.
  - `'offers the projects after the schedule type, starting on None'`: `findByLabelText('Procore project')` has value `''` and holds the options `None` and `BKK-03 — Bangkok 3`.
  - `'keeps the chosen project when the schedule type changes'`: pick `BKK-03`, switch the schedule type (local options with a second type, as in the cost code schedule-type test), and the value stays `'BKK-03'`.
  - `'does not send the project to the planning server'`: pick `BKK-03`, run `requestTwo`, and `JSON.stringify(batches)` does not match `/BKK-03|Bangkok/`.
  - `'creates the sheet with the Procore project on every summary row'`: with cost codes too. Pick `BKK-03`, request two items, Create. The `columns` include `Procore project` (PICKLIST, options `['BKK-03 — Bangkok 3']`) immediately before `Cost code`, and both parent rows hold `'BKK-03 — Bangkok 3'`.
  - `'None leaves the cells empty but adds the column'`.
  - `'hides the field and adds no column when there are no projects'`: default `OPTIONS`.
- [ ] **Step 2: Run them and check they fail.** Run `npx vitest run src/planner/PlannerWizard.test.tsx -t "Procore project"`. Expected: FAIL, no field labelled Procore project.
- [ ] **Step 3: Implement** as in the Behaviour list. The field reuses the existing `planner-field` and `planner-schedule-type` sizing, so no new CSS should be needed. If the select stretches full width, give it the Schedule type field's width class.
- [ ] **Step 4: Run them and check they pass.** Run `npx vitest run src/planner`. Expected: PASS.
- [ ] **Step 5: Extend the e2e test.** In the multi-item test in `e2e/planner.spec.ts`, add `procoreProjects: [{ code: 'BKK-03', name: 'Bangkok 3', isProgram: false }]` to its OPTIONS and select `BKK-03` in `dialog.getByLabel('Procore project')`. After Create, check `gridCell(page, 1, 'Procore project')` reads `'BKK-03 — Bangkok 3'`, `gridCell(page, 2, 'Procore project')` reads `''`, and `gridCell(page, 16, 'Procore project')` reads `'BKK-03 — Bangkok 3'`. Also extend the phone test: the dialog shows the Procore project field and the rows still don't scroll sideways.

  Run: `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npm run test:e2e -- e2e/planner.spec.ts --trace off`
  Expected: PASS (the variable is only needed where Edge isn't installed).
- [ ] **Step 6: Full check, then commit.** Run `npm test && npx tsc -b`; expected: all green. Commit with the message `Plan with AI: choose the Procore project; the sheet gets it`.

---

## Not in this plan (per spec)
Delivery site per item, allocating a batch to sites, per-project cost code lists, an admin screen,
any Procore sync, and the program project itself (it's a one-row migration once Procore has it).
