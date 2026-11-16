# Capability comparison: Smartsheet platform vs this product

Date: 2026-11-16. Replaces the earlier version of this note, which leaned on one account's data.

## How this was made (and what was deliberately not done)
Capabilities were taken from Smartsheet's public REST API: the resources and endpoints that exist, and the
properties of their objects (probed read-only with the owner's token: `/serverinfo`, `/sheets`, `/reports`,
`/sights`, `/workspaces`, `/webhooks`, `/groups`, `/users`, `/favorites`, `/search`, `/templates`,
`/events` and the sub-resources of a sheet), together with the published API documentation. Nothing from
the account's own data is recorded here. Smartsheet's software was **not** decompiled or scraped (their
terms and copyright); every feature below is built from scratch as original code.

## Capability matrix
Status: **have** / **partial** / **missing**. "API evidence" is what the live API showed or documents.

### 1. Sheet model
| Capability | API evidence | Ours |
| --- | --- | --- |
| Column types: text/number, date, date-time, checkbox, picklist, multi-picklist, contact, multi-contact, duration, predecessor | column `type`; `isMultiPicklistEnabled` | have except date-time, multi-contact |
| System columns: auto-number, created/modified by and date | `systemColumnType` | missing |
| Symbol columns (RYG, priority, harvey balls, ...) | `symbol` | missing |
| Column validation, formats, locked/hidden columns, tags, widths | column `validation`, `format`, `locked`, `hidden`, `tags`, `width` | partial (validation, width; no hide/lock/format) |
| Column formulas and cell formulas | column/cell `formula` | partial: cell level only |
| Hierarchy: parent/sibling rows, expand/collapse | row `parentId`, `siblingId`, `expanded` | have |
| Row/cell formatting and conditional formatting | cell `format`, rules | missing |
| Cell links across sheets, cross-sheet references | `linkInFromCell`, `/crosssheetreferences` | missing |
| Row attachments, comments/discussions, cell history | `/attachments`, `/discussions`, `/rows/{id}/history` | missing |
| Sheet summary fields | `/summary`, `hasSummaryFields` | missing |
| Filters (saved, shared) and sort | `/filters`, `filteredOut` | partial (filter and sort; not saved/shared) |
| Locked rows, row numbers, row move/copy | `locked`, `rowNumber` | partial |

### 2. Formula language
Smartsheet functions in real use: IF, AND, OR, COUNT, COUNTIF(S), SUMIF(S), MIN/MAX/AVG, VARIANCE,
WORKDAY, NETWORKDAYS, CALCDURATION, hierarchy functions CHILDREN, PARENT, ANCESTORS, DESCENDANTS,
cross-sheet `{reference}` with INDEX/MATCH/COLLECT/JOIN. Ours: arithmetic, SUM, IF, NETDAYS, TODAY. **Missing**
the project and hierarchy functions and column-level formulas.

### 3. Project management
| Capability | API evidence | Ours |
| --- | --- | --- |
| Gantt, dependencies FS/SS/FF/SF with lag | `ganttEnabled`, `dependenciesEnabled` | have |
| Working calendar (days, non-working dates, hours per day) | `projectSettings` | have |
| Critical path, show/hide | `inCriticalPath`, `userSettings.criticalPathEnabled` | have (plus float, free float) |
| Summary tasks / roll-ups, display toggle | `displaySummaryTasks` | have |
| Baselines (variance) | baseline column types | data layer done, screens next |
| Resource management (assignments, allocation, workload) | `resourceManagementEnabled`, `resourceManagementType` | missing |

### 4. Views
Grid (have), Gantt (have), Card/Kanban (have), **Calendar (missing)**, **Forms for data entry (missing)**,
Timeline in dashboards (missing).

### 5. Smart assets: Reports, Dashboards, Workspaces
| Capability | API evidence | Ours |
| --- | --- | --- |
| **Reports**: rows pulled live from many sheets, filtered, grouped, summarised, editable in place | `/reports`, `sourceSheets`, `isSummaryReport` | missing |
| **Dashboards**: widgets (title, chart, metric/cell link, Gantt grid, timeline, image, shortcut, rich text) positioned on a grid | `/sights`, widget `type`, `xPosition`, `yPosition`, `width`, `height` | missing |
| **Workspaces and folders** with shared access | `/workspaces`, folders | missing |
| Templates | `/templates` | have (own set) |
| Favorites, Home, global Search | `/favorites`, `/home`, `/search` | missing |
| Publish: read-only link, iCal, embeddable | `/publish` | missing |

### 6. Notifications and automation
| Capability | API evidence | Ours |
| --- | --- | --- |
| Automation rules: notify on change, recurring reminders, request updates, request approval, lock/move/copy rows | `/automationrules`, actions `NOTIFICATION_ACTION`, `UPDATE_REQUEST_ACTION`, ... | missing |
| Update requests (send, track sent) | `/updaterequests`, `/sentupdaterequests` | missing |
| Email a row or sheet, attachments by e-mail | `/rows/emails` | missing |
| Webhooks (change events) | `/webhooks` | missing |
| Audit/event stream (admin) | `/events` (403 without plan) | missing |

### 7. Collaboration and administration
Sharing with roles (viewer/editor/editor-can-share/admin/owner), groups, contacts, users, proofing
(`/proofs`), reviews. **Ours: missing** (an implementation exists in PR #4 but needs accounts; the MVP has
none). Locale and formats: 104 locales, 16 formats. **Ours: English only.**

### 8. Ecosystem products (outside the core API)
WorkApps (packaged apps: sheets + reports + dashboards behind role-based pages, mobile), Resource
Management (separate product and API), Control Center (portfolio/blueprint provisioning), Bridge
(workflows), Data Shuttle (scheduled imports), Dynamic View, DataTable. **Ours: none.**

## Where this product is already ahead
AI schedule drafting from history, backward planning from a required date, critical path **with float
and free float**, multi-item long-lead planning, baselines with working-day variance, theming, and a
roadmap for Monte Carlo and a risk register.

## Proposed build waves (each demoable; each builds on the last)
1. **Smart assets**: workspaces/folders, then reports (cross-sheet) and dashboards (metric, chart, Gantt,
   timeline, text widgets). This is the biggest visible gap.
2. **Notifications and automation**: rule engine (when a cell changes / date arrives / row added, then
   notify, request an update, request approval, lock/move rows), update requests, in-app and e-mail
   notifications, webhooks.
3. **Formula engine**: column formulas, hierarchy and project functions (CHILDREN, PARENT, ANCESTORS,
   WORKDAY, NETWORKDAYS, CALCDURATION, VARIANCE, COUNTIF(S), SUMIF(S), INDEX/MATCH), cross-sheet
   references; conditional formatting and symbol columns; system columns.
4. **Resource management**: people and roles, assignments on tasks, allocation by week, workload and
   over-allocation views, capacity calendars; feeds the critical-path view.
5. **Apps (WorkApps-style)**: package sheets, reports and dashboards into a role-based app with its own
   navigation; mobile-first.
6. Comments/attachments/history, calendar view, forms, sheet summary, export (Excel/PDF), publish links.
7. Sharing and roles once sign-in returns; locales.
