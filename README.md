# SmartSheet (construction work management)

A grid + Gantt + Kanban work-management app for small and mid-size construction teams. One
sheet of typed columns drives all three views, with a built-in scheduling engine (working-day
calendar, FS/SS/FF/SF dependencies with lag and lead, parent rollups, cycle detection).

The concepts follow common spreadsheet-style work-management tools; the code, UI and branding
are original. Design: [`docs/superpowers/specs/`](docs/superpowers/specs/). Build plan:
[`docs/superpowers/plans/`](docs/superpowers/plans/).

## Features

- **Sign-in and per-user sheets** (Supabase Auth, row-level security on every table)
- **Sharing**: the owner shares a sheet by email as viewer (read-only grid, Gantt and Kanban) or
  editor (can edit rows, columns and dependencies); only the owner renames, deletes, changes
  schedule settings or shares
- **CSV import**: "Import CSV" on the sheet list creates a sheet (date and checkbox columns are
  inferred when every value fits; up to 5,000 rows, 50 columns, 10 MB)
- **Grid**: typed columns (text/number, date, checkbox, picklist, multi-picklist, contact,
  duration, predecessor), inline editing with validation, row hierarchy (Tab / Shift+Tab),
  drag to reorder, collapse, sort and filter, basic formulas (`SUM`, `IF`, arithmetic,
  comparisons, `[Column]` references, `TODAY()`, `NETDAYS()`), virtualized for thousands of rows
- **Columns**: add, insert, rename (formula references follow), change type, edit dropdown
  options and delete, from each column header's menu (Shift+F10 on a cell opens it)
- **Selection and clipboard**: Shift+Arrow / Shift+click range selection; copy, cut and paste as
  tab-separated text compatible with other spreadsheet apps; Backspace clears a range
- **Schedule settings**: per-sheet working weekdays, hours per day, non-working dates, and
  whether dependencies drive dates
- **Gantt**: bars, milestones, parent summary bars, dependency arrows, drag to move or resize
- **Critical path and float**: the "Critical path" switch in the sheet header highlights critical
  rows and links on the Gantt and in the grid and shows each row's total and free float in
  working days (needs dependencies on)
- **Kanban**: lanes from any picklist column (Status by default), drag cards between lanes
- **Templates**: Project schedule, Punch list, Simple list, with trade and status presets
- **App templates** ("Create app from template" on the sheet list): Construction Management, Data
  Center Build, Real Estate Development and Tenant Fit-Out. Each creates a phased, scheduled
  project-plan sheet (durations, dependencies, disciplines, roles), supporting sheets (RFI log,
  punch list, risk register, long-lead equipment, commissioning tracker, due diligence, leasing
  tracker) and, optionally, a linked Resource Management project with a placeholder person per
  role booked phase by phase. Templates live in `src/apps/catalog.ts`
- **Resource Management** (header switch next to Sheets):
  - *People*: team directory (role, discipline, location, tags, hours per day, bill rate, office
    status), filters, first/last-name sort, saved views
  - *Schedule*: people (or projects) against a day/week/month timeline with availability strips,
    assignment bars (click the lane to assign; drag to move, drag an edge to resize; undo/redo),
    allocation heatmap, people and project filters, saved views
  - *Projects*: portfolio list or cards with type, client, dates, owner, budget status and the
    linked sheet; *Add work from a sheet* creates a project from a sheet's dates and turns
    contacts that match people into assignments
  - *Reports*: who is available this week and next, active projects tracked in currency or days
    (incurred vs future scheduled vs budget, with the forecast), and live saved reports with CSV
    export
  - *My Work*: the signed-in user's assignments (matched by email)
- **Saving**: optimistic edits, background save with retry, unsaved-changes guard

## Getting started

Requirements: Node 20+ and a Supabase project.

```bash
npm install
```

```bash
cp .env.example .env.local
```

Fill `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in `.env.local`, then apply the
migrations in `supabase/migrations/` in order (`0004_resource_management.sql` adds the
Resource Management tables, `0005_sharing.sql` adds sharing) (Supabase SQL editor, or `supabase db push`
with the Supabase CLI).

```bash
npm run dev
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm test` | Unit, component and database (PGlite) tests with Vitest |
| `npm run build` | Type-check, production build, bundle check |
| `npm run test:e2e` | Playwright end-to-end tests against an in-memory fake Supabase |

The e2e suite uses Microsoft Edge by default. To use another Chromium binary:

```bash
PW_CHROMIUM_PATH=/path/to/chromium npm run test:e2e
```

## Layout

```
src/engine/      scheduling: durations, calendar, predecessors, forward pass, cycles
src/formula/     formula evaluator (tokenizer + recursive-descent parser, no eval)
src/model/       cell validation and row-tree operations
src/store/       Zustand sheet store and Supabase persistence
src/auth/        sign-in and sheet list
src/views/       grid, Gantt and Kanban views
src/templates/   construction templates and picklist presets
supabase/        migrations (schema, RLS)
e2e/             Playwright specs and the fake Supabase used by them
```

## Not yet included

Real-time collaboration and sharing, dashboards and reports, automation and forms, baselines,
date constraints, resource loading, and an importer from other tools.
