# SmartSheet (construction work management)

A grid + Gantt + Kanban work-management app for small and mid-size construction teams. One
sheet of typed columns drives all three views, with a built-in scheduling engine (working-day
calendar, FS/SS/FF/SF dependencies with lag and lead, parent rollups, cycle detection).

The concepts follow common spreadsheet-style work-management tools; the code, UI and branding
are original. Design: [`docs/superpowers/specs/`](docs/superpowers/specs/). Build plan:
[`docs/superpowers/plans/`](docs/superpowers/plans/).

## Features

- **No sign-in (MVP)**: each browser gets an anonymous Supabase session on its first visit, so
  visitors keep their own sheets (row-level security on every table) without an account. Needs
  "Allow anonymous sign-ins" turned on in the Supabase project (Authentication → Sign In / Providers)
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
- **Plan with AI**: pick a schedule type (long-lead equipment procurement) and one or several
  equipment items, each with its own on-site date; the server drafts activities and durations from
  historical projects, the plan is worked backward to each date, and you approve it into one
  editable sheet (a summary row per item). A batch has a 3.5-minute overall time limit; items that
  run out of time are drafted from history alone
- **Gantt**: bars, milestones, parent summary bars, dependency arrows, drag to move or resize
- **Critical path and float**: the "Critical path" switch in the sheet header highlights critical
  rows and links on the Gantt and in the grid and shows each row's total and free float in
  working days (needs dependencies on)
- **Kanban**: lanes from any picklist column (Status by default), drag cards between lanes
- **Templates**: Project schedule, Punch list, Simple list, with trade and status presets
- **Import CSV**: create a sheet from a CSV file (first row = headers; date, checkbox and text columns are
  detected; up to 5,000 rows and 50 columns)
- **Saving**: optimistic edits, background save with retry, unsaved-changes guard

## Getting started

Requirements: Node 22.12+ and a Supabase project.

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
| `npm run build` | Type-check, production build, bundle check, then `build:server` |
| `npm run build:server` | Compile the planning server to `dist-server/` |
| `npm start` | Production: the planning server, serving `dist/` and `/api` |
| `npm run dev:server` | Planning server in watch mode on port 8787 (`npm run dev` proxies `/api` to it) |
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
src/planner/     AI planner contract, draft validation, history-only drafts
server/          planning server (Node): auth, planner API, Claude drafting, static SPA
supabase/        migrations (schema, RLS)
e2e/             Playwright specs and the fake Supabase used by them
```

## Planning server and deployment

The AI planner's server (`server/`) verifies the user's Supabase session, reads the activity
catalog and duration history with the user's token (row-level security applies), asks Claude
for a draft through one `propose_plan` tool call, validates it, and falls back to a
history-only draft when the AI is not configured, fails, or returns an invalid plan twice. In
production the same process serves the built SPA, so the app and `/api` share one origin.

Environment variables:

| Variable | When | Purpose |
| --- | --- | --- |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | build | Baked into the browser bundle |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | runtime | Server-side token checks and history reads (default to the `VITE_` values) |
| `ANTHROPIC_API_KEY` | runtime | Enables AI drafting; server-side only, never `VITE_`-prefixed. Without it drafts use history only |
| `ANTHROPIC_MODEL` | runtime, optional | Defaults to `claude-opus-5-5` |
| `PORT` | runtime | Set by Railway; 8787 locally |
| `PLANNER_DRAFTS_PER_HOUR` | runtime, optional | AI drafts each user may request per rolling hour (default 10) |
| `PLANNER_MAX_CONCURRENT_DRAFTS` | runtime, optional | Drafts in progress across all users (default 8); each user may have one at a time |
| `PLANNER_DRAFTS_PER_HOUR_TOTAL` | runtime, optional | AI drafts across all users per rolling hour (default 60) |

Each AI draft can cost several large model calls, so the server limits drafts per user and in
total, and stops the AI call when the browser disconnects. Without sign-in anyone can get a new
anonymous account, so the total hourly cap is what bounds cost: also set a monthly spend limit
on the Anthropic key.

Railway: `railway.json` builds with `npm run build` (Railpack) and starts
`node dist-server/server/main.js` with a health check on `/api/health`. Set the variables above
on the service; Railway exposes them to the build too, which the `VITE_` ones need.

## Not yet included

Real-time collaboration and sharing, dashboards and reports, automation and forms, baselines,
date constraints, resource loading, and an importer from other tools.
