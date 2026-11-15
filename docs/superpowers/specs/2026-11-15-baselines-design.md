# Baselines: design

Date: 2026-11-15. Status: building (owner said to keep going; defaults below are the coordinator's calls).

## Why
A planner must freeze "the plan we agreed" and then see how the live schedule drifts from it:
which tasks are late, by how many working days, and whether the project finish has moved. Without
baselines the product cannot be used for progress reporting, and it is the base for later schedule
risk analysis (Monte Carlo compares outcomes against the baseline finish).

## Decisions (coordinator's calls; change by telling the owner)
- Up to **5 baselines per sheet** (slots 1-5, like P6). Each has a name and a creation time.
  Saving into a used slot overwrites it (confirm in the UI).
- A baseline is a **snapshot of the schedule**: for every scheduled row (summary rows included) its
  start, end and duration in working days, plus the project finish. Not a copy of the whole sheet:
  dependencies and cell values are not snapshotted in v1.
- Rows are matched by **row id**. A row added after the baseline is `new`; a row deleted since is
  `removed` (listed, not an error).
- **Variance** is in working days on the sheet's calendar: current date minus baseline date
  (positive = later = late). Start variance, finish variance, duration variance. A row is `late`
  when finish variance > 0, `ahead` when < 0, `on-track` when 0.
- Baselines are read-only once saved and survive row deletion (no foreign key to `rows`).
- Per-sheet, owner-only under the same row-level security as every other table.

## Not in v1
Comparing two baselines, baseline of dependencies/costs, resource-loaded baselines, approval
workflow, auto-baseline on a schedule.

## Parts
1. `src/engine/baseline.ts`: pure snapshot and variance functions (tested).
2. Migration `0006_baselines.sql`: `baselines` and `baseline_rows` with RLS.
3. Persistence and store: load baselines with the sheet; save, delete; pure UI state (which
   baseline is shown) stays in the view.
4. UI (after the redesign lands): Baselines menu in the sheet toolbar (save, rename, delete,
   choose which to show), a thin baseline bar under each Gantt task, variance columns and a
   late/ahead badge in the grid, a project-finish variance summary.
