# New project from the wizard: design

Date: 2026-11-23. Status: decisions agreed with the owner; awaiting approval of this text.

## Why
Planners plan projects that don't exist yet, e.g. a new data centre at feasibility stage, before it is
set up in Procore or in our project list. Today the Project list is fixed in the database, so a new
project needs a migration from a developer. The owner wants **any planner** to be able to define a new
(including a placeholder, "dummy") project from the wizard, and use it like any other from then on.

## Goals / non-goals / anti-goals
- Goals
  - The wizard's Project list has **+ New project…**. A planner enters a code and a name, selects **Add
    project**, and it is saved to the shared list and selected.
  - The new project is an ordinary project from then on: every planner sees it, for every schedule type,
    imports, and (Data centre) as a delivery site.
  - When the project is later created in Procore with the same project number, **Sync with Procore**
    finds and syncs it without a developer, and marks it as in Procore.
- Non-goals (this round): renaming or deleting projects; adding programme projects; limiting who can add.
- Anti-goals: duplicate or near-duplicate codes; codes or names that break the sheet's dropdowns (commas)
  or the catalog rules; a planner able to change projects they did not create, or to mark a project as in
  Procore themselves.

## Decisions (owner)
- Saved to the shared project list (not just for one plan).
- Any planner may add a project.
- Accepted proposals: **+ New project…** as the last option; fields Code and Name; **Add project** saves
  and selects; duplicate code → "BKK-04 already exists", nothing saved; the project takes the project
  type on screen and starts **not in Procore**; listed as "BKK-04 — Bangkok 4 (new)"; who added it and
  when are recorded; Sync with Procore finds and marks it once it exists in Procore.

## Approaches
1. **Insert from the browser under a row-level-security rule (chosen).** A new insert policy lets a signed-in
   user add a project only as themselves, not in Procore, not a programme. The database enforces the code
   format, name rules and uniqueness. No new server endpoint; the wizard already reads projects from the
   same table.
2. A server endpoint that validates and inserts. Same rules, one more route and request to maintain, and
   the database would still need the rules. Rejected.
3. A per-user list of projects. Not shared, so other planners would not see it. Rejected (owner chose A).

## Design

### Database (migration `0024_planner_projects.sql`)
- `projects` gains `created_by uuid references auth.users (id) on delete set null` and
  `created_at timestamptz not null default now()`. Existing rows: `created_by` null (seeded by migrations).
- Code rule for all rows: the existing `^[A-Z0-9][A-Z0-9-]*$`, plus `length(code) <= 20`. Name rule: the
  existing non-blank, no commas, plus `length(name) <= 80`.
- Insert policy `projects_insert_own` for `authenticated`:
  `with check (created_by = auth.uid() and in_procore = false and is_program = false and in_planner = true)`.
  `grant insert (code, name, project_type, created_by, in_procore, is_program, in_planner) on projects to authenticated`.
  No update or delete for authenticated users.
- Uniqueness is the primary key on `code` (exact). Codes are entered upper-case (the field upper-cases as the
  planner types), so `bkk-04` and `BKK-04` cannot both exist.

### Wizard
- The Project list (wherever it shows: request step and the import's "What we found") gets a last option
  **+ New project…**. Choosing it shows, under the list:
  - **Code** — upper-cased as typed; hint "Capitals, digits and hyphens, up to 20 (e.g. BKK-04)".
  - **Name** — e.g. "Bangkok 4"; no commas.
  - **Add project** and **Cancel**.
- **Add project** checks the fields (messages: "Enter a code", "Use capitals, digits and hyphens (up to 20)",
  "Enter a name", "A name cannot contain a comma"), then inserts
  `{ code, name, project_type: <project type on screen>, created_by: <user id>, in_procore: false,
  is_program: false, in_planner: true }`. A duplicate key error → "BKK-04 already exists"; any other error →
  "Could not add the project: <reason>". Nothing else changes on failure.
- On success the project is added to the wizard's options (no reload), selected, and the fields close.
- Labels: a project with `created_by` set and `in_procore = false` is shown as "BKK-04 — Bangkok 4 (new)"
  in the wizard's list. The sheet's Project column stores "BKK-04 — Bangkok 4" (no "(new)"), so sheets don't
  change when the project reaches Procore.
- Options loading (`history.ts`) reads `created_by` so the client knows which projects are planner-added.

### Sync with Procore
- `POST /api/procore/committed` today answers `not-in-procore` for any project not marked `in_procore`.
  It now looks up **every** listed project the caller can read; `not-in-procore` remains for codes that are
  not in the caller's list at all. A project not found in Procore answers `not-found` as today.
- When a project not marked `in_procore` is found in Procore, the server marks it (`in_procore = true`)
  using the service-role Supabase client when `SUPABASE_SERVICE_ROLE_KEY` is set (it is the existing
  server-side key used by automation). Without that key the project still syncs; only the mark (and so the
  "(new)" label) stays.
- The side panel's project match already matches any listed project by number; unchanged.

## Testing
- Migration (PGlite): a user can insert a project as themselves (not in Procore, not programme); cannot
  insert as someone else, as in Procore, or as a programme; cannot update or delete; code and name rules
  (lower-case, too long, comma); duplicate code rejected.
- Wizard: New project fields, validation messages, success selects it and shows "(new)", duplicate error,
  Cancel; works in the import's project field; project type taken from the screen.
- Sync: a listed project not marked in Procore is looked up and synced; it is marked when the service client
  is configured; a code not in the list is `not-in-procore`.
- e2e: add BKK-04 from the wizard and plan with it.

## Calls left to the builder
- Where the fields sit on a phone-width / 400-px panel (stacked under the list).
- Wording of the hint, within the above.

## Risks
- Any planner can add projects, so the list can collect typos; renaming and deleting are deferred.
- Planner-added projects stay labelled "(new)" if the service-role key is not configured.
- A planner can add a code that matches any Procore project the app's Procore account can see; the sync then
  reads its commitments and marks it, keeping the name the planner typed. Seeded sample projects are now looked
  up too (answered "not found" rather than "not in Procore").
- `created_by` (a user id) is readable by every signed-in user, like the rest of the project list.
