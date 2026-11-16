# Resource management: assignments, allocation, workload

Status: built (engine, database, store, UI, tests). Reference behaviour: the resource-management
product in the Smartsheet suite, as documented publicly (no code or assets copied).

## What it does

- A **resource** is a person, a role (for example "Electrical engineer") or a piece of equipment, with a
  name, department, skills, a cost rate per hour, a **weekly capacity** (hours for each weekday) and
  **time off / exceptions** (date ranges with their own hours per day: 0 = away, 4 = half days, 6 on a
  Saturday = an extra shift).
- Tasks on a project sheet get **assignments**: a resource with an **allocation**. An assignment follows
  its task: dates are never stored, they are read from the live schedule, so moving a task moves the
  hours. An assignment may carry **dates of its own**, which replace the task's dates (and it then stays
  put when the task moves).
- **Workload**: resource x day/week/month heat map of assigned vs available hours, over-allocation
  flagged, click a cell for the tasks behind the number, a utilisation summary, filters (department, type,
  search over name and skills, over-allocated only) and sorting.
- **Find a resource**: who is free in a date range for a stated need (hours per day, % of capacity, total
  hours, or anyone), filtered by department, type and skills, best fit first.
- **Leveling suggestions**: tasks that can start later, within their float, to remove an
  over-allocation. Advisory: never applied.

## Allocation semantics

A task occupies the **working days of its own sheet's calendar** between its start and end (a milestone
occupies none). A resource's capacity on a day is its weekly pattern, overridden by time off (where
ranges overlap the smallest figure wins).

| Allocation | Hours on a task day |
| --- | --- |
| `percent` (1 to 1000) | value% of the resource's capacity that day. Part days work out naturally (50% of a 4 h day = 2 h); nothing on time off. Above 100% is allowed on purpose: it shows as over-allocation. |
| `hours_per_day` (to 24) | value hours on every task day on which the resource has capacity. |
| `hours_per_week` (to 168) | the weekly figure divided by the resource's working days per week, placed like `hours_per_day`. |
| `total_hours` (to 100,000) | spread over the task days with capacity in proportion to that day's capacity (a 4 h day gets half of an 8 h day). The total is always exact. |

If the resource has no capacity on any task day (for example the whole task falls in time off) the
fixed-hours kinds fall back to *all* task days, so the demand shows up as an over-allocation instead of
vanishing. `percent` of zero capacity is zero.

**Over-allocated** = assigned hours > available hours. This is judged per day; a week or month cell is
flagged when its total is over or any day inside it is, so a Monday peak is not hidden by a quiet
Friday. Heat levels: free, under 50%, 50 to 85%, 85 to 100%, over.

## Leveling

Greedy and sequential (see `src/resources/leveling.ts`): worst-over-allocated resource first; for each
still-over day, the tasks on it that have float are tried (largest float first) at a delay of 1, 2, ...
working days of the task's own sheet calendar. A delay is accepted only if it takes the task off every
over-allocated day it contributes to for that resource and makes nothing worse anywhere (moving a task
moves all of its following assignments, so other resources are checked too). Free float is tried first
(no later task moves); only then total float (successors move, the project end does not). Critical
tasks, tasks with unknown float (dependencies off) and assignments with their own dates are never moved.
Accepted moves are applied to a working copy so later suggestions see them. It stops at 100 suggestions
or 200,000 trials and says so. It reads float from `analyzeCriticalPath`; `src/engine` is untouched.

## Data (supabase/migrations/0010_resources.sql)

| Table | Notes |
| --- | --- |
| `resources` | owner-level (not per sheet). `kind`, `department`, `skills text[]`, `cost_rate`, `hours_by_weekday numeric(4,2)[7]` with CHECKs (7 values, 0 to 24, no nulls). `unique (id, owner_id)` for same-owner child keys. |
| `resource_time_off` | date range, `hours` 0 to 24, note; range at most 3660 days. FK `(resource_id, owner_id)`, cascade. |
| `assignments` | `sheet_id` FK (cascade), `row_id` plain uuid with **no FK** (like `baseline_rows`: history survives a deleted task; an orphan carries no load), `resource_id` via `(resource_id, owner_id)` cascade, `allocation_kind` / `allocation_value` with per-kind ceilings, optional own dates, `unique (sheet_id, row_id, resource_id)`. |

Security posture as 0002 / 0006: RLS on, one `for all to authenticated` policy per table with
`(select auth.uid())`, `workspace_id = auth.uid()`, the sheet must belong to the caller, `revoke all from
anon, public`. Verified with PGlite in `src/db/resources.test.ts` (not against a live Supabase project).

## App structure

- `src/resources/engine.ts`, `leveling.ts`: pure, no I/O. `taskFacts.ts` turns a sheet into engine input.
- `persistence.ts` (Supabase) and `resourceStore.ts` (zustand). Resources are global to the owner;
  assignments load lazily, only when the Resources page or a sheet's assign panel is opened, then the
  tasks of each sheet that has assignments are read and scheduled (4 sheets at a time). The open sheet's
  live schedule is pushed into the store so assignments follow edits immediately.
- UI: `ResourcesPage` (Workload, Resources, Find a resource, Leveling) and `AssignPanel` (a "Resources"
  button in the sheet toolbar opens a non-modal side panel; a bottom sheet on phones). The panel lists the
  sheet's tasks (pick several, or click a task in the grid / Gantt), shows who is assigned, and previews
  the hours, the resource's weekly load with this assignment and any over-allocation before saving.

## Not built (deliberately)

- Auto-leveling; leveling is a suggestion list.
- Holiday calendars per resource (use time off), resource cost reporting and budgets, skills matching
  beyond a case-insensitive "has all of these" filter, assignment requests and approvals.
- Cleaning up assignments whose task was deleted (kept as history; they carry no load).
- Resource edits are not atomic across the resource row and its time off (time off is added before the
  old rows are removed, so a failure never loses it).
