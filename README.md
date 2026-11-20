# SmartSheet (construction work management)

A grid + Gantt + Kanban work-management app for small and mid-size construction teams. One
sheet of typed columns drives all three views, with a built-in scheduling engine (working-day
calendar, FS/SS/FF/SF dependencies with lag and lead, parent rollups, cycle detection).

The concepts follow common spreadsheet-style work-management tools; the code, UI and branding
are original. Design: [`docs/superpowers/specs/`](docs/superpowers/specs/). Build plan:
[`docs/superpowers/plans/`](docs/superpowers/plans/).

## Features

- **Sign-in and per-user sheets**: e-mail and password accounts (Supabase Auth), row-level security
  on every table
- **Sharing**: the owner shares a sheet by email as viewer (read-only grid, Gantt and Kanban) or
  editor (can edit rows, columns and dependencies); only the owner renames, deletes, changes
  schedule settings or shares. Baselines, automation rules, resources and WhatsApp settings stay
  the owner's
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
- **Property development master schedule** (Plan with AI → Properties, the first schedule type
  there): the Property department's reference template (44 activities and control gates in 15
  stages, from feasibility to close-out, with lead responsibility, completion / release criteria and
  the reference FS / SS logic) is the catalog the AI drafts from, with the template's *Basis of Plan*
  rules as guidance. Give the development and its planned handover date; the plan is worked back
  from handover (the defects period and close-out follow it), and the sheet gets *Activity ID*,
  *Lead responsibility* and *Completion / release criteria* columns. Default durations are
  placeholders until history is loaded. Source: `src/planner/catalogs/propertyDevelopment.ts`
  (seeded by `0018_property_development.sql`)
- **Gantt**: bars, milestones, parent summary bars, dependency arrows, drag to move or resize
- **Critical path and float**: the "Critical path" switch in the sheet header highlights critical
  rows and links on the Gantt and in the grid and shows each row's total and free float in
  working days (needs dependencies on)
- **Kanban**: lanes from any picklist column (Status by default), drag cards between lanes
- **Templates**: Project schedule, Punch list, Simple list, with trade and status presets
- **Import CSV**: create a sheet from a CSV file (first row = headers; date, checkbox and text columns are
  detected; up to 5,000 rows and 50 columns)
- **App templates** ("Create app from template" on the sheet list): Construction Management, Data
  Center Build, Real Estate Development and Tenant Fit-Out. Each creates a phased, scheduled
  project-plan sheet (durations, dependencies, disciplines, roles), supporting sheets (RFI log,
  punch list, risk register, long-lead equipment, commissioning tracker, due diligence, leasing
  tracker) and, optionally, a linked People & projects booking with a placeholder person per
  role booked phase by phase. Templates live in `src/apps/catalog.ts`
- **People & projects** (portfolio resource management; separate from the task-level *Resources*):
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
- **WhatsApp assistant** (WhatsApp page): link your phone with a one-time code, then on WhatsApp pick
  a project and use the menu (delayed, due in 30 days, at risk / on track, critical path, milestones,
  delay reminders to task owners, summary), see a task with `#N`, update it with `N Complete`,
  `N 60%` or `N In progress - note`, get the full list by e-mail, or ask a question in your own words
  (Claude answers from the sheet's data only). Per sheet: delay alerts to task owners, progress
  checks at 50 / 70 / 90 % of a task's time with reminders and a no-response report, a daily
  summary, quiet hours. Site contacts (subcontractors without an account) join from an invitation
  and can see and update only their own tasks. Automation "Notify" rules can also send on
  WhatsApp. Runs as a simulator with a test chat until WhatsApp credentials are set (see below).
  Design: [`docs/superpowers/specs/2026-11-19-whatsapp-assistant-design.md`](docs/superpowers/specs/2026-11-19-whatsapp-assistant-design.md)

## Getting started

Requirements: Node 22.12+ and a Supabase project.

```bash
npm install
```

```bash
cp .env.example .env.local
```

Fill `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in `.env.local`, then apply the
migrations in `supabase/migrations/` in order (Supabase SQL editor, or `supabase db push` with the
Supabase CLI). `0016_resource_management.sql` (People & projects) and `0017_sharing.sql` were
`0004` / `0005` on the older `main` line; a database that already applied them under those numbers
needs only the others (see *Migration numbering* below).

```bash
npm run dev
```

### Migration numbering

Two lines of work were merged: the planner, automation, assets and WhatsApp line (`0004` to `0015`)
and the sharing and People & projects line, whose migrations were `0004_resource_management.sql`
and `0005_sharing.sql`. They are now `0016_resource_management.sql` and `0017_sharing.sql`, applied
after the others (sharing last, because it replaces the owner-only policies of `columns`, `rows` and
`dependencies`). A fresh database just applies every file in order. A database that already applied
the old `0004`/`0005` files has those tables: apply the remaining files and skip `0016`/`0017`
(with the Supabase CLI, record them as applied with `supabase migration repair --status applied 0016 0017`).

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
total, and stops the AI call when the browser disconnects. Anyone can still sign up for an
account, so the total hourly cap is what bounds cost: also set a monthly spend limit on the
Anthropic key.

### WhatsApp

The assistant (`server/whatsapp/`) needs `SUPABASE_SERVICE_ROLE_KEY` and migration
`0015_whatsapp.sql`. Without WhatsApp credentials it runs as a **simulator**: nothing is sent,
messages are stored and shown on the WhatsApp page, whose test chat plays the phone.

| Variable | Purpose |
| --- | --- |
| `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | Meta WhatsApp Cloud API: a permanent (system user) token and the sender's phone number id. Both set = real messages |
| `WHATSAPP_APP_SECRET` | The Meta app secret. Every webhook POST must carry a valid `X-Hub-Signature-256`; without it the webhook refuses everything |
| `WHATSAPP_VERIFY_TOKEN` | Any string; enter the same in Meta's webhook settings |
| `WHATSAPP_BUSINESS_NUMBER` | The sender's number with country code (for the `wa.me` links in link codes and invitations) |
| `WHATSAPP_TEMPLATE_NAME`, `WHATSAPP_TEMPLATE_LANG` | Optional. An approved template with one body parameter (`{{1}}`), used for alerts and summaries outside WhatsApp's 24-hour window; without it those are skipped (and logged) when the person has not written in the last 24 hours |
| `WHATSAPP_MESSAGES_PER_DAY` | Outbound messages per account per day (default 300) |
| `WHATSAPP_ALERT_MINUTES` | How often each enabled sheet is checked for alerts (default 15) |

Meta setup: create a Meta app with the WhatsApp product, add a phone number, and set the webhook
callback URL to `https://<your app>/api/whatsapp/webhook` with the verify token above, subscribed to
`messages`. For the template, create a *Utility* template such as “Project update: {{1}}” and put
its name in `WHATSAPP_TEMPLATE_NAME`.

Railway: `railway.json` builds with `npm run build` (Railpack) and starts
`node dist-server/server/main.js` with a health check on `/api/health`. Set the variables above
on the service; Railway exposes them to the build too, which the `VITE_` ones need.

## Not yet included

Real-time collaboration and sharing, dashboards and reports, automation and forms, baselines,
date constraints, resource loading, and an importer from other tools.
