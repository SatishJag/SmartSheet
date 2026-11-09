# Construction Work-Management App: MVP Design

Date: 2026-11-09
Status: Draft for review

## 1. Purpose and scope

A Smartsheet-style work-management product built in React, tuned for **construction** teams (small to mid-size contractors), intended as the start of a commercial product.

Smartsheet is the reference for *concepts* (typed-column grid, row hierarchy, dependencies, Gantt and Kanban views over one data set). The implementation, UI design and branding are original. No Smartsheet code, assets or branding are used. Concepts were taken from Smartsheet's public API documentation only.

### In the MVP
- Sign-in and per-user sheets
- Grid: typed columns, inline editing, row hierarchy (indent/outdent), sort and filter, basic formulas
- Gantt view with dependencies (FS, SS, FF, SF, with lag and lead)
- Kanban view grouped by a picklist column
- Scheduling engine (working-day calendar, rollups, cycle detection)
- Two construction templates: project schedule and punch list

### Not in the MVP
Real-time collaboration and sharing, dashboards and reports, automation and forms, billing, enterprise SSO, formulas beyond the basic set, a Smartsheet importer (a good early follow-up).

## 2. Architecture

- **Frontend:** React + TypeScript SPA built with Vite.
- **Sheet store:** the single in-memory source of truth (sheets, columns, rows, cells, dependencies). It is the only layer that talks to the backend and exposes a small interface to the views.
- **Grid view:** TanStack Table + TanStack Virtual, with our own cell renderers and editors, row hierarchy, sort and filter.
- **Gantt view and Kanban view:** separate components reading the same store. Editing a date in the grid moves the Gantt bar. Dragging a Kanban card writes a picklist cell.
- **Scheduling engine:** a pure TypeScript module with no UI or database dependency.
- **Formula evaluator:** a standalone module (SUM, IF, basic date math).
- **Backend:** Supabase (Postgres, Auth, row-level security). Realtime is not used in v1.

## 3. Data model

Postgres tables, every one carrying `owner_id` and `workspace_id` so sharing can be added later without a migration:

- `sheets`: id, name, owner_id, workspace_id, calendar settings (working days, hours per day), dependencies_enabled
- `columns`: id, sheet_id, title, type, position, options (JSON), system_type (nullable), width
- `rows`: id, sheet_id, parent_id (nullable), position (fractional index), cells (JSON object keyed by column id), version
- `dependencies`: id, sheet_id, predecessor_row_id, successor_row_id, type (FS, SS, FF, SF), lag_minutes (negative means lead)

Column types: text/number, date, checkbox, picklist, multi-picklist, contact, duration, predecessor, plus system columns (auto-number, created by/date, modified by/date). Picklists support symbol sets (for example RYG).

Cells store a raw value; a formatted display value is derived on render. Formulas are stored as text alongside the value in the cell JSON.

Cells are stored in a JSON column on the row (not one table row per cell) so a 5,000-row sheet loads quickly. Individual cells can still be patched.

### Dependencies
Dependencies are stored as rows. The predecessor column displays and accepts a string such as `12FS +3d 4h`, which is parsed into dependency rows. Leads are written with a negative sign (`12FS -2d`). This is our own syntax choice.

## 4. Scheduling engine

Input: rows, dependencies, calendar. Output: start, end and duration per row, plus errors.

- Working-day calendar per sheet; elapsed durations (prefix `e`, for example `e3d`) ignore non-working time.
- Duration strings: `w`, `d`, `h`, `m` units; zero duration is a milestone.
- Forward pass computes start and end from predecessors; changing end updates duration and vice versa.
- Parent rows roll up start (earliest), end (latest), duration and % complete from children; parent values are read-only.
- Cycle detection blocks the offending dependency and names the rows.
- Formulas are not allowed in scheduled columns when dependencies are enabled.
- Critical path is a later addition.

## 5. Views

- **Grid:** virtualized rows, indent/outdent, drag to reorder (updates the fractional position), column resize, sort and filter.
- **Gantt:** bars from start/end, milestones, dependency arrows, drag to change dates (writes through the engine).
- **Kanban:** cards grouped by one picklist column (status by default); dragging writes the cell.

## 6. Error handling

- Cell input is validated against column type; an invalid value shows an error marker and is not saved.
- Dependency cycles are blocked with a message; dependencies pointing at deleted rows are removed and the user is told.
- Edits apply optimistically and save in the background. A failed save shows an unsaved state, retries, then shows a banner. Nothing is dropped.
- Concurrent edits are last-write-wins per cell in v1; the row `version` field is reserved for conflict detection later.
- Row-level security enforces ownership on every table.

## 7. Testing

- Scheduling engine: heavy unit tests (calendars, all four dependency types with lag and lead, rollups, milestones, cycles).
- Predecessor parser: unit tests including malformed input.
- Store and grid: component tests for editing, indent/outdent, sort and filter.
- End to end (Playwright): sign in, create a sheet, edit a cell, drag a Kanban card, see the Gantt bar move.
- Database: tests that row-level security blocks cross-user access.

## 8. Construction specifics

- **Project schedule template:** phase, task, trade, duration, start, end, predecessors, status, % complete.
- **Punch list template:** item, location, trade, assigned to, status, due date.
- Presets for trade/subcontractor and construction status picklists.
- Kanban defaults to grouping by status.

## 9. Open questions and risks

- Smartsheet's exact object schemas and formula syntax were not retrievable from the public docs we read. We do not depend on them; the design above is self-contained. Before building a Smartsheet importer, read the OpenAPI schema section directly.
- Legal: Smartsheet's terms of service may restrict reverse engineering of their product. This design uses only public API documentation and original code. Confirm with counsel before commercial launch.
- The headless grid (TanStack) means selection, copy/paste and accessibility are ours to build; budget for that in the plan.
