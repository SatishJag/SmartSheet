# New project from the wizard: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A planner adds a project (code and name) from the wizard's Project list; it is saved to the shared list, selected, and later found and marked by Sync with Procore.

**Architecture:** A migration adds `created_by`/`created_at`, tighter code/name rules and an own-row insert policy. The wizard inserts from the browser through RLS (a small `addProject` module plus a `NewProjectFields` component used in both Project fields). The sync route looks up every listed project and, with the service-role key, marks found ones as in Procore.

**Tech Stack:** Postgres/Supabase RLS (PGlite tests), React 18 + TS, Node server, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-23-new-project-design.md`

## Global Constraints
- Code: `^[A-Z0-9][A-Z0-9-]*$`, at most 20 characters; upper-cased as typed. Name: non-blank, no commas, at most 80 characters.
- Messages, verbatim: "Enter a code", "Use capitals, digits and hyphens (up to 20)", "Enter a name", "A name cannot contain a comma", "<CODE> already exists", "Could not add the project: <reason>", and (builder's wording for the 80 limit) "A name can be up to 80 characters".
- Option label in the wizard: "BKK-04 — Bangkok 4 (new)" for planner-added projects not in Procore. The sheet stores "BKK-04 — Bangkok 4" (no "(new)").
- Inserted row: `{ code, name, project_type: <type on screen, or 'data-centre' with no types>, created_by: userId, in_procore: false, is_program: false, in_planner: true }`.
- No update or delete for authenticated users. Never let a planner set `in_procore = true`.

## Review Focus
1. Lower-case or spaced code typed (" bkk-04 ") → trimmed and upper-cased before checks; no DB round trip for a bad code.
2. Add project pressed twice quickly → one insert; button disabled while saving.
3. Project type changed while the New project fields are open → the project is saved under the type on screen at the time of Add.
4. Service-role mark fails (network/DB) → the sync result is still returned; the failure is only logged.
5. Program projects and sample property projects (in_procore false, created_by null) are now looked up in Procore → answered `not-found`, never an error.

---

### Task 1: Migration 0024

**Files:**
- Create: `supabase/migrations/0024_planner_projects.sql`
- Test: `src/db/projects.test.ts` (new `describe('0024 planner-added projects')`)

**Interfaces:** Produces columns `projects.created_by uuid`, `projects.created_at timestamptz`, policy `projects_insert_own`.

- [ ] **Step 1: Write failing tests** (as `USER`, a second user `OTHER`): inserts `('BKK-04','Bangkok 4','data-centre', created_by=USER, in_procore=false, is_program=false, in_planner=true)` succeeds and is readable with `created_at` set; rejects: `created_by = OTHER`, `created_by` null, `in_procore = true`, `is_program = true`, `in_planner = false`, code `bkk-04`, code of 21 chars, name of 81 chars, name with a comma, duplicate `BKK-04`; `update projects set name='X' where code='BKK-04'` changes nothing or throws; `delete` likewise. Existing test 'is read-only for users' keeps passing.
- [ ] **Step 2:** `npx vitest run src/db/projects.test.ts` → new tests FAIL.
- [ ] **Step 3: Write the migration** (header comment in the style of 0022): add the two columns; `add constraint projects_code_length check (length(code) <= 20)`, `projects_name_length check (length(name) <= 80)`; the insert policy with `with check (created_by = auth.uid() and in_procore = false and is_program = false and in_planner = true)`; `grant insert (code, name, project_type, created_by, in_procore, is_program, in_planner) on projects to authenticated`. Update the existing constraint-name test to include the two new names.
- [ ] **Step 4:** tests PASS; `npx vitest run src/db` all pass.
- [ ] **Step 5:** Commit.

### Task 2: Client project model and `addProject`

**Files:**
- Modify: `src/planner/types.ts` (`Project.addedByPlanner?: boolean`), `src/planner/history.ts` (select `created_by`; `addedByPlanner: r.created_by != null`), `src/planner/projects.ts`
- Create: `src/planner/addProject.ts`, `src/planner/addProject.test.ts`
- Test: existing history tests for the select list.

**Interfaces (produces):**
- `projectListLabel(p: Project): string` in `projects.ts` — `projectOption(p)` plus `' (new)'` when `p.addedByPlanner && !p.inProcore`.
- `normaliseCode(raw: string): string` — trim + upper-case.
- `checkNewProject(code: string, name: string): { code?: string; name?: string }` — the four field messages.
- `addProject(client: SupabaseClient, userId: string, input: { code: string; name: string; projectType: string }): Promise<{ ok: true; project: Project } | { ok: false; error: string }>` — 23505 → "`<CODE>` already exists"; other errors → "Could not add the project: <message>". Returned project: `{ code, name: name.trim(), isProgram: false, projectType, inProcore: false, addedByPlanner: true }`.

- [ ] **Step 1:** Failing tests: `checkNewProject('', '')` → both "Enter …"; `'bkk 04'` → "Use capitals…"; 21-char code → same; `'A, B'` name → comma message; 81-char name → "A name can be up to 80 characters"; `projectListLabel` with/without "(new)"; `addProject` with a fake client: sends the exact row, maps 23505 and other errors; history maps `created_by`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** Commit.

### Task 3: Wizard New project fields

**Files:**
- Create: `src/planner/NewProjectFields.tsx`
- Modify: `src/planner/PlannerWizard.tsx` (both Project selects: request step ~l.898 and import ~l.1202), `src/planner/planner.css` if needed
- Test: `src/planner/PlannerWizard.test.tsx`

**Interfaces:** Consumes Task 2. `NewProjectFields({ client, userId, projectType, onAdded(p: Project), onCancel() })`. Wizard: a last option `value="__new__"` labelled "+ New project…" opens the fields (the select keeps the current project); `onAdded` appends to `options.projects` via `setOptions`, selects it, closes the fields. Option text uses `projectListLabel`; the sheet's Project column keeps `projectOption`.

- [ ] **Step 1:** Failing tests: choosing "+ New project…" shows Code (hint "Capitals, digits and hyphens, up to 20 (e.g. BKK-04)") and Name; typing `bkk-04` shows `BKK-04`; empty Add shows both messages and does not insert; success inserts the Global-Constraints row with the on-screen project type, selects "BKK-04 — Bangkok 4 (new)", closes the fields; duplicate shows "BKK-04 already exists" and keeps fields; Cancel closes without inserting; Add disabled while saving (double click → one insert); works in the import's project field; the created sheet's Project cell is "BKK-04 — Bangkok 4".
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS plus `npx vitest run src/planner`. **Step 5:** Commit.

### Task 4: Sync looks up and marks planner-added projects

> **Reverted (owner decision, option 1, after the Devin security review):** the sync again looks up only projects marked in Procore; a planner-added project is marked by hand. See the spec's "Sync with Procore".

**Files:**
- Modify: `server/app.ts` (committed route; `AppDeps.markInProcore?: ((code: string) => Promise<void>) | null`), `server/main.ts` (service client when `SUPABASE_SERVICE_ROLE_KEY` and URL are set: `update projects set in_procore = true where code = $code and in_procore = false`), `src/planner/types.ts` comment on `not-in-procore`
- Test: `server/procoreRoute.test.ts`

- [ ] **Step 1:** Failing tests: a listed project with `inProcore: false` is looked up (VIL-01 → `not-found` when Procore lacks it; a planner project BKK-04 found → `ok`); `markInProcore` called once with 'BKK-04' only when found and not already in Procore; a rejecting `markInProcore` still answers 200 and logs `procore.mark.failed`; an unlisted code stays `not-in-procore`.
- [ ] **Step 2:** FAIL. **Step 3:** implement: mark only projects answered `ok` that were listed with `inProcore: false`. **Step 4:** PASS. **Step 5:** Commit.

### Task 5: e2e and docs

**Files:** `e2e/support/fakeSupabase.ts` (a `projects` table only if the wizard reads it there; otherwise route the insert), `e2e/planner.spec.ts`, `docs/procore-app-setup.md` (one line: planner-added projects sync once their Procore project number matches).

- [ ] **Step 1:** e2e: add BKK-04 from the wizard, plan with it, sheet shows "BKK-04 — Bangkok 4". **Step 2:** run e2e planner spec. **Step 3:** full `npx vitest run`, `npx tsc -b`. **Step 4:** Commit.
