# Feature gap against Smartsheet (from the public API and one real account)

Date: 2026-11-16

## How this was made (and what was deliberately not done)
Source: Smartsheet's public, documented REST API read with the owner's own API token (read only),
plus the published API documentation. The survey recorded structure only (counts, column types,
settings, widget and automation types, formula function names): no cell values, names or e-mail
addresses are stored here. Smartsheet's software was **not** decompiled, scraped or copied (their
terms and copyright; see the legal note in the MVP design). Everything we build is original code.

## What the surveyed account uses
13 sheets (4 are project sheets with Gantt, dependencies and durations), 18 reports, 5 dashboards,
6 workspaces, sharing on every sheet, automation rules on 3 sheets, column formulas on 10, validated
columns on 7, resource management on 1, a cross-sheet reference on 1.
- Column types: mostly text/number (273), then date-time (14), picklist (12), date (8), duration (7),
  predecessor (4), contact list (3). Symbol sets: RYG, priority.
- Dashboard widgets: title, Gantt grid, chart, cell link (a number/metric tile), image, timeline,
  shortcut icon.
- Automations: notification and update-request actions.
- Formula functions seen: IF, AND, COUNT, COUNTIF, MIN, AVG, VARIANCE, WORKDAY, CALCDURATION and the
  hierarchy functions CHILDREN and ANCESTORS (project-schedule use).
- Max 52 columns and 513 rows in one sheet.

## Status in our product
| Capability | Status |
| --- | --- |
| Grid, typed columns, hierarchy, sort/filter, copy/paste, column management | have |
| Gantt, dependencies (FS/SS/FF/SF, lag), durations, calendars | have |
| Critical path and float | have |
| Baselines | data layer done, screens next |
| Kanban (card) view | have |
| Templates, AI schedule drafting (LLE) | have (beyond Smartsheet) |
| Basic formulas (arithmetic, SUM, IF, NETDAYS, TODAY) | partial: cell level only |
| **Column formulas and the project functions** (CHILDREN, ANCESTORS, WORKDAY, VARIANCE, CALCDURATION, COUNTIF, AND/OR, AVG, MIN/MAX) | missing |
| **Reports** (rows pulled from many sheets, filtered, grouped, summarised, with live links back) | missing |
| **Dashboards** (title, chart, metric, Gantt and timeline widgets) | missing |
| **Workspaces and folders** | missing |
| **Automation** (notify on change, recurring reminders, update requests, approvals) | missing |
| Sharing with viewer/editor roles | built in PR #4 (blocked: needs accounts, MVP has none) |
| CSV import | built in PR #4 |
| Export (Excel, PDF, CSV) | missing |
| Resource management (assignments, allocation, workload) | missing |
| Sheet summary (key fields at the top of a sheet) | missing |
| Calendar view | missing |
| Forms (public data-entry forms) | missing |
| Cell comments, discussions, attachments, change history | missing |
| Conditional formatting, symbol columns (RYG, priority) | missing |
| Cross-sheet references | missing |
| Update requests and proofing | missing |

## Proposed order (each step is demoable and builds on the last)
1. Baselines screens (in progress) and Excel/CSV/PDF export.
2. Column formulas with the hierarchy and project functions; conditional formatting and symbols.
3. Reports (cross-sheet) and dashboards (metric, chart, Gantt, timeline widgets). Needs workspaces.
4. Workspaces/folders, then automation (notifications, update requests) and comments/attachments.
5. Resource management; calendar view; forms; sheet summary.
6. Sharing and roles once sign-in returns.
