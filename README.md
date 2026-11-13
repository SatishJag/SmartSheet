# SmartSheet (construction work management)

A grid + Gantt + Kanban work-management app for small and mid-size construction teams. One
sheet of typed columns drives all three views, with a built-in scheduling engine (working-day
calendar, FS/SS/FF/SF dependencies with lag and lead, parent rollups, cycle detection).

The concepts follow common spreadsheet-style work-management tools; the code, UI and branding
are original. Design: [`docs/superpowers/specs/`](docs/superpowers/specs/). Build plan:
[`docs/superpowers/plans/`](docs/superpowers/plans/).

## Features

- **Sign-in and per-user sheets** (Supabase Auth, row-level security on every table)
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
- **Kanban**: lanes from any picklist column (Status by default), drag cards between lanes
- **Templates**: Project schedule, Punch list, Simple list, with trade and status presets
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
migrations in `supabase/migrations/` in order (Supabase SQL editor, or `supabase db push`
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

Real-time collaboration and sharing, dashboards and reports, automation and forms, critical
path, and an importer from other tools.
