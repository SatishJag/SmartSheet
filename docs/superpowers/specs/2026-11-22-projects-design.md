# Projects for both businesses: design

Date: 2026-11-22. Status: approaches agreed with the owner; awaiting approval of this text.

## Why
Plan with AI serves two businesses: **Data centre** (long-lead equipment and its own schedules) and
**Properties** (villas, towers, master communities, infrastructure). Every plan belongs to a project,
so the **project is required**. Cost codes don't exist on many projects (especially properties), so
the **cost code stays optional**. Property projects are not in Procore yet: for the MVP they are
**sample projects**, clearly marked, to be replaced by real ones later. This also prepares the Procore
sync, which will read POs only for projects that are linked to Procore.

## Goals / non-goals / anti-goals
- Goals: a project is required before Generate; the project list shows only the chosen project type's
  projects; property planning works with sample projects; each project says whether it is in Procore.
- Non-goals: the Procore sync itself (next), real property projects, an admin screen for projects.
- Anti-goals: sample projects that look like real Procore projects; blocking planning because the
  project list could not load.

## Approaches
1. Add the two columns to the existing `procore_projects` table: smallest, but the table name would
   hold non-Procore projects.
2. **Rename it to a general `projects` table and add the two columns (chosen).** Names match the data;
   the sync reads the linked projects.
3. A separate table for property projects: two lists to keep in step. Rejected.

## Decisions (owner)
- Project required; cost code optional (already optional today).
- Property projects are samples for the MVP.
- Approach 2.

## Proposals the owner did not correct (taken as agreed)
- The list is filtered by the chosen **project type** (Data centre / Properties).
- Four sample property projects, one per kind: `VIL-01 — Sample villa`, `TWR-01 — Sample tower`,
  `MC-01 — Sample master community`, `INF-01 — Sample infrastructure`; not linked to Procore.
- **Cost code** and **Delivery site** show only for **Data centre** plans (the codes are data centre
  equipment, the sites are data centre sites).

## Design
**Database** (migration `0022_projects.sql`)
- Rename `procore_projects` to `projects` (data, policies and grants carry over).
- Add `project_type text not null default 'data-centre' references project_types (id)` and
  `in_procore boolean not null default true`. Existing rows (`PRG-DC-01`, `BKK-03`) keep the defaults.
- Insert the four sample property projects with `project_type = 'properties'`, `in_procore = false`,
  `is_program = false`.

**Wizard**
- The field is labelled **Project** (was "Procore project") and lists only projects of the chosen
  project type, program projects first, then by code.
- **Required**: Generate is blocked with "Choose the project" until one is chosen.
- Changing the project type clears a chosen project that does not belong to the new type.
- Cost code and Delivery site show only when the project type is Data centre. Delivery sites are the
  Data centre projects that are not programs.

**Sheet**
- The column is titled **Project** (was "Procore project") on new sheets; same `CODE — Name` text, same
  rows as before. Sheets already created keep their old column title.

## Calls left to the builder (coordinator's)
- If the project list is empty or failed to load for the chosen project type, the field is hidden and
  not required, so planning never fails because of the list (same rule as the other lists).
- `PlannerOptions.procoreProjects` becomes `projects`, each with `projectType` and `inProcore`; types
  and helpers are renamed to match (`procoreProjects.ts` → `projects.ts`).
- The migration must be applied to the live Supabase project after merge, as with 0019–0021.
