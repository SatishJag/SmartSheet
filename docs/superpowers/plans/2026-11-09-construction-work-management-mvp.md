# Construction Work-Management App MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a React grid + Gantt + Kanban work-management app for construction teams, backed by Supabase, with its own scheduling engine.

**Architecture:** Pure-TypeScript engine modules (duration, calendar, predecessors, scheduling, formulas) with no UI or database dependency; a Zustand sheet store as the single source of truth that persists through a `Persistence` interface; three views (grid, Gantt, Kanban) reading the store. Supabase provides Postgres, Auth and row-level security.

**Tech Stack:** TypeScript, React 18, Vite, Vitest, @testing-library/react, Playwright, Zustand, @tanstack/react-table, @tanstack/react-virtual, fractional-indexing, @supabase/supabase-js, Supabase CLI (pgTAP for database tests).

**Spec:** `docs/superpowers/specs/2026-11-09-construction-work-management-mvp-design.md`

## Global Constraints

- Language and UI: TypeScript (strict mode), React; all code original, no Smartsheet code, assets or branding.
- Dependency types: FS, SS, FF, SF, with lag and lead; leads written with a negative sign (`12FS -2d`).
- Predecessor string format: row number, type code, optional lag, comma-separated (`12FS +3d 4h, 14SS`); type defaults to FS.
- Duration units `w`, `d`, `h`, `m`; `e` prefix means elapsed (`e3d`); zero duration is a milestone. 1w = 5d. A working day is `hoursPerDay` hours (default 8).
- Dates are ISO strings `YYYY-MM-DD`, computed in UTC. The v1 engine is day-granular: sub-day durations round up to 1 working day.
- Parent rows are read-only for start, end, duration and % complete (rolled up from children).
- Formulas are not allowed in Start, End, Duration, % Complete or Predecessor columns when dependencies are enabled.
- Every table carries `owner_id` and `workspace_id`; row-level security on every table; `rows.version` is reserved for later conflict detection.
- Row order uses a fractional `position`; cells are stored as a JSON object keyed by column id on the row.
- v1 concurrency is last-write-wins per cell.
- Out of scope: collaboration/sharing, dashboards, automation, forms, billing, SSO, Smartsheet importer, critical path.

## Review Focus

1. A sheet with zero rows, or rows but no dependencies, renders in all three views and schedules without error.
2. A predecessor naming a nonexistent row number, or the row's own number, is rejected with a message and not saved.
3. A start date entered on a non-working day (weekend or listed non-working date) moves to the next working day.
4. Indenting the first row (no previous sibling) and outdenting a top-level row are no-ops, not errors; deleting a parent deletes its children after confirmation.
5. A Kanban card with an empty status lands in a "No status" lane; pasting text into a number or date cell shows an error and keeps the old value.

## File Structure

```
src/engine/{types,duration,calendar,predecessor,schedule,cycles}.ts   pure scheduling logic
src/formula/evaluate.ts                                               formula evaluator
src/model/{validate,hierarchy}.ts                                     cell validation, row-tree operations
src/store/{sheetStore,persistence}.ts                                 state + Supabase persistence
src/auth/{AuthGate,SheetList}.tsx                                     sign-in and sheet list
src/views/grid/*  src/views/gantt/*  src/views/kanban/*               the three views
src/templates/{projectSchedule,punchList}.ts                          construction templates
supabase/migrations/0001_schema.sql   supabase/tests/rls.test.sql     schema, RLS, pgTAP tests
e2e/*.spec.ts                                                         Playwright
```

---

### Task 1: Scaffold and duration parsing

**Files:**
- Create: project scaffold (`npm create vite@latest . -- --template react-ts`, add vitest, @testing-library/react, jsdom), `src/engine/types.ts`, `src/engine/duration.ts`
- Test: `src/engine/duration.test.ts`

**Interfaces:**
- Produces: `type DepType = 'FS'|'SS'|'FF'|'SF'`; `interface Calendar { workingWeekdays: number[]; nonWorkingDates: string[]; hoursPerDay: number }` (0 = Sunday); `parseDuration(s: string, hoursPerDay?: number): { minutes: number; elapsed: boolean } | null`; `formatDuration(d: { minutes: number; elapsed: boolean }, hoursPerDay?: number): string`; `toWorkingDays(d, hoursPerDay): number` (rounds up).

- [ ] **Step 1: Failing tests** (`duration.test.ts`): `"4d"` → `{minutes:1920, elapsed:false}`; `"2w"` → `{minutes:4800, elapsed:false}`; `"4h 30m"` → minutes 270; `"e3d"` → `{minutes:4320, elapsed:true}`; `"0d"` → minutes 0; `"banana"`, `""` → null; `formatDuration(parseDuration("4d"))` → `"4d"`; `toWorkingDays({minutes:60,elapsed:false})` → 1.
- [ ] **Step 2:** Run `npx vitest run src/engine/duration.test.ts`; expect FAIL (module missing).
- [ ] **Step 3:** Implement the functions above in `duration.ts`; define shared types in `types.ts`. Case-insensitive units, whitespace-separated segments.
- [ ] **Step 4:** Run the tests; expect PASS. Also run `npm run build` to confirm the scaffold compiles.
- [ ] **Step 5:** Commit `feat: scaffold app and duration parsing`.

### Task 2: Working calendar

**Files:** Create `src/engine/calendar.ts`; Test `src/engine/calendar.test.ts`

**Interfaces:**
- Consumes: `Calendar` (Task 1).
- Produces: `isWorkingDay(cal, iso): boolean`; `nextWorkingDay(cal, iso): string` (same day if already working); `addWorkingDays(cal, iso, n): string` (start must be a working day; `n` may be negative); `defaultCalendar: Calendar` (Mon–Fri, 8h).

- [ ] **Step 1: Failing tests:** with `defaultCalendar`, `2026-11-09` is Monday. `isWorkingDay('2026-11-14')` false (Saturday); `nextWorkingDay('2026-11-14')` → `'2026-11-16'`; `addWorkingDays('2026-11-13', 3)` → `'2026-11-18'`; `addWorkingDays('2026-11-16', -1)` → `'2026-11-13'`; a calendar with `nonWorkingDates:['2026-11-10']` makes `addWorkingDays('2026-11-09', 1)` → `'2026-11-11'`.
- [ ] **Step 2:** Run `npx vitest run src/engine/calendar.test.ts`; expect FAIL.
- [ ] **Step 3:** Implement using UTC `Date` arithmetic, stepping one day at a time.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `feat: working-day calendar`.

### Task 3: Predecessor parser

**Files:** Create `src/engine/predecessor.ts`; Test `src/engine/predecessor.test.ts`

**Interfaces:**
- Consumes: `DepType`, `parseDuration` (Task 1).
- Produces: `interface Pred { rowNumber: number; type: DepType; lagMinutes: number }`; `parsePredecessors(s: string, hoursPerDay?: number): { ok: true; value: Pred[] } | { ok: false; error: string }`; `formatPredecessors(p: Pred[], hoursPerDay?: number): string`.

- [ ] **Step 1: Failing tests:** `"12FS +3d 4h"` → `[{rowNumber:12,type:'FS',lagMinutes:1680}]`; `"14SS"` → lag 0; `"7"` → FS lag 0; `"5FF -2d"` → lagMinutes -960; `"12FS +3d 4h, 14SS"` → two entries; `"bad"`, `"12XX"`, `"0"` → `ok:false` with a message; `formatPredecessors(parse("12FS +3d 4h").value)` round-trips.
- [ ] **Step 2:** Run the file; expect FAIL.
- [ ] **Step 3:** Implement with a per-item regex; lag text goes through `parseDuration` with sign applied.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `feat: predecessor parser`.

### Task 4: Scheduling forward pass

**Files:** Create `src/engine/schedule.ts`; Test `src/engine/schedule.test.ts`

**Interfaces:**
- Consumes: `Calendar`, calendar functions (Task 2), `toWorkingDays` (Task 1).
- Produces:
  `interface SchedRow { id: string; parentId: string | null; durationMinutes: number; elapsed: boolean; manualStart: string | null; percentComplete: number }`
  `interface SchedDep { predecessorId: string; successorId: string; type: DepType; lagMinutes: number }`
  `interface Scheduled { start: string; end: string; durationDays: number; percentComplete: number }`
  `schedule(rows: SchedRow[], deps: SchedDep[], cal: Calendar): { byRow: Record<string, Scheduled>; errors: { rowId: string; message: string }[] }`

- [ ] **Step 1: Failing tests** (calendar Mon–Fri, task A manualStart `2026-11-09`, 3d → A runs `11-09`→`11-11`): FS successor B (2d) starts `2026-11-12`, ends `2026-11-13`; FS +1d lag → B starts `2026-11-13`; FS -1d lead → B starts `2026-11-11`; SS lag 0 → B starts `2026-11-09`; FF → B ends `2026-11-11`; SF → B ends `2026-11-09`; two predecessors → the later constraint wins; 0-minute duration → start equals end (milestone); manualStart `2026-11-14` (Saturday) → start `2026-11-16`; elapsed `e3d` starting Friday ends Sunday.
- [ ] **Step 2:** Run the file; expect FAIL.
- [ ] **Step 3:** Implement `schedule` with a topological order over `deps`; a row with no predecessors uses `manualStart`; a row with neither predecessors nor `manualStart` gets the error `"No start date"` and is left unscheduled. Duration days = `toWorkingDays`, minimum 1 unless 0 minutes; end = `addWorkingDays(start, days-1)`.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `feat: scheduling forward pass`.

### Task 5: Rollups and cycle detection

**Files:** Create `src/engine/cycles.ts`; Modify `src/engine/schedule.ts`; Test `src/engine/cycles.test.ts`, extend `schedule.test.ts`

**Interfaces:**
- Consumes: `SchedDep`, `schedule` (Task 4).
- Produces: `findCycle(deps: SchedDep[]): string[] | null` (row ids in the cycle); `schedule` additionally fills parent rows.

- [ ] **Step 1: Failing tests:** `findCycle([A→B, B→C, C→A])` returns a list containing A, B and C; acyclic input → null; a self-dependency → `[A]`. Rollup: parent P with children C1 (`11-09`→`11-10`) and C2 (`11-11`→`11-13`) gets start `2026-11-09`, end `2026-11-13`, durationDays 5, and percentComplete weighted by child duration (C1 100%, C2 0% → 40). Nested parents roll up bottom-up. A schedule input containing a cycle returns an error per row in the cycle and does not throw.
- [ ] **Step 2:** Run both files; expect FAIL.
- [ ] **Step 3:** Implement `findCycle` (DFS) and call it at the top of `schedule`; add a bottom-up rollup pass for rows that have children.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `feat: parent rollups and cycle detection`.

### Task 6: Formula evaluator

**Files:** Create `src/formula/evaluate.ts`; Test `src/formula/evaluate.test.ts`

**Interfaces:**
- Produces: `evaluate(formula: string, ctx: { cell(colTitle: string, rowIndex: number): unknown; rowIndex: number }): { ok: true; value: number | string | boolean } | { ok: false; error: string }`. Supports `=SUM(range)`, `=IF(cond, a, b)`, arithmetic, comparisons, `[Column Title]` references to the same row, and `TODAY()`, `NETDAYS(d1, d2)`.

- [ ] **Step 1: Failing tests:** `=1+2*3` → 7; `=SUM([Cost])` over a column of 1, 2, 3 → 6; `=IF([Qty]>2, "big", "small")` with Qty 3 → `"big"`; `=NETDAYS("2026-11-09","2026-11-13")` → 4; `=1/0` and `=FOO(1)` → `ok:false`; a formula referencing an unknown column → `ok:false` with the column name.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement a tokenizer + recursive-descent parser; never use `eval`.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `feat: formula evaluator`.

### Task 7: Cell validation

**Files:** Create `src/model/validate.ts`; Test `src/model/validate.test.ts`

**Interfaces:**
- Consumes: `parseDuration`, `parsePredecessors`.
- Produces: `type ColumnType = 'TEXT_NUMBER'|'DATE'|'CHECKBOX'|'PICKLIST'|'MULTI_PICKLIST'|'CONTACT_LIST'|'DURATION'|'PREDECESSOR'`; `interface Column { id: string; title: string; type: ColumnType; options?: string[]; systemType?: string }`; `validateCell(col: Column, raw: string, ctx: { rowCount: number; ownRowNumber: number }): { ok: true; value: unknown } | { ok: false; error: string }`.

- [ ] **Step 1: Failing tests:** DATE `"banana"` fails, `"2026-11-09"` passes; DATE `"2026-02-30"` fails; DURATION `"4d"` passes, `"x"` fails; PICKLIST value not in options fails; CHECKBOX `"true"` → true; CONTACT_LIST `"not an email"` fails; PREDECESSOR `"99"` with `rowCount: 10` fails ("row 99 does not exist"); PREDECESSOR equal to `ownRowNumber` fails; a leading `=` on a non-schedule column passes through as a formula string.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement a per-type switch; reject formulas in DURATION, PREDECESSOR and date-roll-up columns.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `feat: cell validation`.

### Task 8: Row hierarchy operations

**Files:** Create `src/model/hierarchy.ts`; Test `src/model/hierarchy.test.ts`; add dependency `fractional-indexing`

**Interfaces:**
- Produces: `interface RowNode { id: string; parentId: string | null; position: string }`; `indent(rows, id): RowNode[]` (becomes last child of previous sibling; no-op for first sibling); `outdent(rows, id): RowNode[]` (placed after its former parent; no-op at top level); `moveRow(rows, id, afterId: string | null, newParentId: string | null): RowNode[]` (uses `generateKeyBetween`); `visibleOrder(rows, collapsed: Set<string>): string[]`; `deleteWithChildren(rows, id): { rows: RowNode[]; removedIds: string[] }`.

- [ ] **Step 1: Failing tests:** indenting row 2 under row 1 sets its parentId; indenting row 1 returns the input unchanged; outdent moves a child after its parent; outdent of a top-level row is a no-op; `moveRow` yields a position strictly between its neighbours; collapsed parents hide descendants in `visibleOrder`; deleting a parent returns all descendant ids.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement as pure functions returning new arrays.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `feat: row hierarchy operations`.

### Task 9: Supabase schema and RLS

**Files:** Create `supabase/migrations/0001_schema.sql`, `supabase/tests/rls.test.sql`

**Interfaces:**
- Produces tables `sheets`, `columns`, `rows`, `dependencies` exactly as in the spec's data model (all with `owner_id uuid`, `workspace_id uuid`), `dependencies.type` constrained to FS/SS/FF/SF, `rows.version int default 0`, and an RLS policy per table allowing access only where `owner_id = auth.uid()`.

- [ ] **Step 1: Failing pgTAP tests** (`rls.test.sql`): user A inserts a sheet and rows; as user B, `select count(*)` from each of the four tables returns 0; user B's insert with `owner_id` = A is rejected; a dependency with type `'XX'` is rejected; deleting a sheet cascades to its columns, rows and dependencies.
- [ ] **Step 2:** Run `supabase test db`; expect FAIL (tables missing).
- [ ] **Step 3:** Write the migration (cascade foreign keys, indexes on `sheet_id` and `(sheet_id, parent_id)`, RLS enabled on all four tables).
- [ ] **Step 4:** Run `supabase db reset && supabase test db`; expect PASS.
- [ ] **Step 5:** Commit `feat: database schema with row-level security`.

### Task 10: Sheet store and persistence

**Files:** Create `src/store/sheetStore.ts`, `src/store/persistence.ts`; Test `src/store/sheetStore.test.ts`

**Interfaces:**
- Consumes: `validateCell`, `hierarchy` ops, `schedule`.
- Produces: `interface Persistence { loadSheet(id: string): Promise<SheetData>; saveCell(rowId: string, colId: string, value: unknown, version: number): Promise<{ version: number }>; saveRowTree(rows: RowNode[]): Promise<void>; saveDependencies(deps: SchedDep[]): Promise<void>; deleteRows(ids: string[]): Promise<void> }`; `createSheetStore(p: Persistence)` returning a Zustand store with state `{ sheet, saveStatus: 'saved'|'saving'|'unsaved'|'failed', errors }` and actions `setCell(rowId, colId, raw)`, `addRow(afterId?)`, `indentRow`, `outdentRow`, `moveRow`, `deleteRow`, `addDependency`, `removeDependency`, `load(id)`. `supabasePersistence(client): Persistence` is the real implementation.

- [ ] **Step 1: Failing tests** (fake `Persistence`): `setCell` updates state before the promise resolves (optimistic); an invalid value leaves the old value and records an error; a rejected save sets `unsaved`, retries 3 times with backoff, then sets `failed` and keeps the value; a dependency that would form a cycle is rejected with a message naming the rows; removing a row removes dependencies that reference it and records a notice; changing a duration re-runs `schedule` and updates dates.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement the store; saves go through a per-cell queue; `supabasePersistence` maps to the tables from Task 9.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `feat: sheet store with optimistic saves`.

### Task 11: Auth and sheet list

**Files:** Create `src/auth/AuthGate.tsx`, `src/auth/SheetList.tsx`, `src/App.tsx` wiring; Test `src/auth/auth.test.tsx`

**Interfaces:**
- Consumes: Supabase client, `createSheetStore`.
- Produces: `<AuthGate>` renders a sign-in form (email + password) until a session exists; `<SheetList>` lists the user's sheets, creates a sheet (optionally from a template id), and opens one.

- [ ] **Step 1: Failing tests** (mock client): unauthenticated render shows the sign-in form; after a session exists, the sheet list shows; "New sheet" calls insert with the user's `owner_id`; an empty list shows an empty-state message.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement with `@supabase/supabase-js`; read URL and anon key from `import.meta.env`.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `feat: auth gate and sheet list`.

### Task 12: Grid view (render and edit)

**Files:** Create `src/views/grid/{GridView,cellEditors,columns}.tsx`; Test `src/views/grid/GridView.test.tsx`

**Interfaces:**
- Consumes: store (Task 10), `Column`.
- Produces: `<GridView />` using `@tanstack/react-table` + `@tanstack/react-virtual`; one editor per column type; double-click or Enter to edit, Enter to commit, Escape to cancel; error marker on invalid input; parent rows render schedule columns read-only.

- [ ] **Step 1: Failing tests:** 5,000 rows render fewer than 100 DOM rows; editing a text cell calls `setCell`; invalid date shows an error marker and keeps the old value; Escape cancels; a parent row's start cell is not editable; a sheet with zero rows renders headers and an empty state.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement the grid with virtualization and the per-type editors (picklist dropdown, date input, checkbox).
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `feat: virtualized grid with typed editors`.

### Task 13: Grid hierarchy, sort and filter

**Files:** Modify `src/views/grid/GridView.tsx`; Create `src/views/grid/{HierarchyCell,FilterBar}.tsx`; Test `src/views/grid/hierarchy.test.tsx`

**Interfaces:**
- Consumes: hierarchy ops via store actions.
- Produces: indent/outdent buttons and Tab/Shift+Tab, collapse toggles, drag-to-reorder calling `moveRow`, header-click sort, and a filter bar (column, operator, value).

- [ ] **Step 1: Failing tests:** Tab indents the focused row; Tab on the first row does nothing and shows no error; collapsing a parent hides its children; sorting by a date column orders rows within the same parent; a filter keeps ancestors of matching rows visible; dragging a row calls `moveRow` with the neighbour ids.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement using `visibleOrder` from Task 8; sort and filter act per sibling group.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `feat: grid hierarchy, sort and filter`.

### Task 14: Predecessor column integration

**Files:** Modify `src/store/sheetStore.ts`; Create `src/views/grid/PredecessorCell.tsx`; Test `src/store/predecessor-integration.test.ts`

**Interfaces:**
- Consumes: `parsePredecessors`, `formatPredecessors`, `findCycle`, `schedule`.
- Produces: setting a PREDECESSOR cell replaces that row's dependency rows; row numbers map to the row's position in visible order; removing or reordering rows re-renders the strings from the dependency rows.

- [ ] **Step 1: Failing tests:** entering `"2FS +1d"` on row 3 creates one dependency from row 2 to row 3 with lagMinutes 480 and moves row 3's dates; entering `"99"` or its own number is rejected with a message and leaves dependencies unchanged; moving row 2 below row 3 updates the displayed string on row 3; a cycle entry is rejected and names the rows; clearing the cell removes the dependencies.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement the translation layer between strings and dependency rows in the store.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `feat: predecessor column drives dependencies`.

### Task 15: Gantt view

**Files:** Create `src/views/gantt/{GanttView,bars,arrows}.tsx`; Test `src/views/gantt/GanttView.test.tsx`

**Interfaces:**
- Consumes: scheduled dates and dependencies from the store.
- Produces: `<GanttView />` in SVG: a bar per row from start to end, a diamond for milestones, parent summary bars, dependency arrows, and drag-to-move/resize which writes through `setCell` (start, duration). Rows align with the grid's visible order.

- [ ] **Step 1: Failing tests:** a 3-day task renders a bar whose width is 3 day-columns; a milestone renders a diamond; a dependency renders one arrow path between the two bars; dragging a bar one day right calls `setCell` for start with the new date; dragging a bar whose row has a predecessor is blocked with a message (start is driven by the dependency); an empty sheet renders an empty timeline.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement with a date-to-x scale and a visible-range window.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `feat: Gantt view with dependencies`.

### Task 16: Kanban view

**Files:** Create `src/views/kanban/{KanbanView,Lane,Card}.tsx`; Test `src/views/kanban/KanbanView.test.tsx`

**Interfaces:**
- Consumes: store; the grouping column is chosen from PICKLIST columns, defaulting to the column titled "Status".
- Produces: `<KanbanView groupByColumnId? />`: a lane per picklist option plus a "No status" lane; dragging a card to another lane calls `setCell` with that option (or empty for "No status").

- [ ] **Step 1: Failing tests:** lanes match the picklist options in order; a row with an empty status appears in "No status"; dropping a card in "Done" calls `setCell(rowId, statusColId, 'Done')`; switching the grouping column re-lanes the cards; a sheet with no picklist column shows a message asking the user to add one.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement with native HTML drag-and-drop.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `feat: Kanban view`.

### Task 17: Construction templates and presets

**Files:** Create `src/templates/{projectSchedule,punchList,presets}.ts`; Test `src/templates/templates.test.ts`

**Interfaces:**
- Consumes: `Column`.
- Produces: `projectScheduleTemplate` (columns: Phase, Task, Trade, Duration, Start, End, Predecessors, Status, % Complete; dependencies enabled), `punchListTemplate` (Item, Location, Trade, Assigned To, Status, Due Date); `TRADE_OPTIONS` and `STATUS_OPTIONS` picklist presets; `createSheetFromTemplate(templateId, ownerId): SheetData`.

- [ ] **Step 1: Failing tests:** each template's column titles and types match the spec; the schedule template has a PREDECESSOR and a DURATION column; the Status column's options equal `STATUS_OPTIONS`; `createSheetFromTemplate` returns fresh ids each call; Kanban's default grouping picks the Status column in both templates.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement as data plus the factory.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `feat: construction templates and presets`.

### Task 18: End-to-end flows

**Files:** Create `e2e/{auth,schedule,kanban}.spec.ts`, `playwright.config.ts`

**Interfaces:**
- Consumes: the whole app against a local Supabase (`supabase start`) with a seeded test user from `supabase/seed.sql`.

- [ ] **Step 1: Failing tests:** sign in with the seeded test user; create a sheet from the project schedule template; set Task 2's predecessor to `1` and see its Gantt bar start after Task 1's bar ends; edit Task 1's duration and see Task 2's bar move; drag a Kanban card to "Done" and see the grid's Status cell change; a second user cannot open the first user's sheet URL.
- [ ] **Step 2:** Run `npx playwright test`; expect FAIL.
- [ ] **Step 3:** Add the seed file and fix any wiring the tests expose in `App.tsx`.
- [ ] **Step 4:** Run `npx playwright test`; expect PASS. Then run the full suite (`npx vitest run`, `supabase test db`).
- [ ] **Step 5:** Commit `test: end-to-end flows`.
