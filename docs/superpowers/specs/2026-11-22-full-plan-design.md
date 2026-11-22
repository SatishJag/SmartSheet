# "All" — the full project plan: design

Date: 2026-11-22. Status: decisions agreed with the owner; awaiting approval of this text.

## Why
Plan with AI plans one schedule type at a time (long-lead equipment, materials, subcontracts…). The owner
wants one option, **All**, that builds the **whole project plan** — design, permits, procurement,
construction, commissioning and handover — with every long-lead package's procurement built in and linked
to the work that installs it, using past projects for durations. The references are the owner's own
templates: the **DC Integrated Project Schedule Reference Template** (Data centre) and the **Property
Development Schedule Template** (Properties). For Data centre it becomes the built-in master template.

## Goals / non-goals / anti-goals
- Goals
  - The wizard offers **All (full project plan)** for both project types.
  - Data centre: a new built-in **Data centre master schedule** with the template's 199 activities, 22
    stages, IDs, names, lead responsibility, completion criteria and links; the six long-lead packages'
    step durations come from history where it exists; the sheet runs on a 7-day calendar.
  - Properties: **All** gives the existing Property development master schedule (the same 44-activity
    template, schedule type `property-development`, already built).
  - The plan is worked back from the **RFS date** (Data centre) / **handover date** (Properties), as every
    plan is today, with the usual "should have started N days ago" warning.
  - Package rows carry their cost code, so **Sync with Procore** works on the plan at once.
- Non-goals (this round): unticking packages; two of the same package; cost codes for Power Modules and
  Fan Wall Units; planning forward from a start date; AI changes to the Data centre master's durations;
  importing the owner's Excel layout (three predecessor columns).
- Anti-goals: a plan that no longer reads like the owner's template (names, IDs, stages, logic); durations
  presented as "from past projects" that are not; a long AI call that can time out on 199 activities.

## Decisions (owner)
- **Package layout A:** keep the template's 9 steps per package; take each step's duration from history
  where we have it (our 14-step long-lead history rolled up into the template's 9 steps). Not our 14-step
  chain.
- **Calendar 1:** the Data centre master uses a **7-day calendar** (every weekday working); the template's
  calendar-day durations stay as written.
- **Direction A:** plan **backward from the RFS date** (DC-0192 "READY FOR SERVICE (RFS) / data-centre
  operations acceptance"); activities after RFS (taking-over, phased handover, defects, close-out) follow
  it, as P430/P440 follow handover in the Properties plan.
- All six packages always included, once each.
- Package rows get cost codes: Chillers **CHL**, Generator Sets **GEN**, Transformers **TRF**, Switchgear
  **HVS**; Power Modules and Fan Wall Units none for now.
- **No AI** for the Data centre master: template + history only.
- Approach: a built-in catalog like the Properties master (below).

## Approaches
1. **Built-in catalog, as the Properties master (chosen).** A script turns the workbook into a code
   module (the source of truth) and a migration seeds the same activities as schedule type `dc-master`;
   the server builds the draft from the catalog plus long-lead history, without the AI.
2. Import the owner's Excel file each time. Rejected: the import does not read the three predecessor
   columns, calls the AI, and a built-in template should not need an upload.
3. Build each package from our 14-step long-lead chain (package layout B). Rejected by the owner.

## Design

### The catalog (`src/planner/catalogs/dcMaster.ts`, migration `0023_dc_master.sql`)
- Generated once by a script from the workbook's **DC Master Schedule** sheet (rows from the heading on
  row 7; columns: WBS code, Stage / workstream, Activity ID, Activity / control gate, Type, Lead
  responsibility, System / package, Duration (calendar days), Predecessor/Relation/Lag ×3, Completion /
  release criteria). Like `propertyDevelopment.ts`: a typed array of activities, `DC_MASTER_TYPE`
  (`id: 'dc-master'`, name "Data centre master schedule", description, `targetId: 'DC-0192'`), and a test
  that the module and the migration agree (as `src/db/propertyDevelopment.test.ts`).
- Each activity: `id` (DC-0001…), `stage` (e.g. "07 LLE Cat A vendor procurement & delivery"), `name`,
  `milestone` (Type = Milestone), `responsibility`, `criteria`, `package` (the "System / package" value
  when it is one of the six packages, else absent), `defaultDays` (template calendar days; 0 for
  milestones), `links` (up to three: `{ from, type: FS|SS|FF|SF, lagDays }`, lags in calendar days).
- Both "Core" and "Conditional" scope activities are included (Conditional: DC-0043, DC-0109).
- The migration inserts `schedule_types` (`dc-master`, `project_types = {data-centre}`, position 0) and the
  199 `activity_catalog` rows (`default_days` = calendar days, `is_target` on DC-0192). The workbook copy
  used by the script is not committed (it is the owner's file); the generated module is.

### Long-lead packages (`src/planner/catalogs/dcPackages.ts`)
A table per package:

| Package | History equipment type | Cost code |
|---|---|---|
| Chillers | Chiller | CHL |
| Generator Sets | Diesel generator | GEN |
| Transformers | Power transformer | TRF |
| Switchgear | HV switchgear | HVS |
| Power Modules | — | — |
| Fan Wall Units (FWU) | — | — |

Each package's 9 steps (in template order) take their duration from these `lle-procurement` history codes:

| Step (template wording) | History codes summed |
|---|---|
| 1 freeze concept datasheets, capacity and interfaces | SPEC |
| 2 vendor shortlist, RFQ, clarifications and technical evaluation | RFQ + BIDEVAL |
| 3 negotiate, approve LOA and execute purchase contract | AWARD |
| 4 vendor drawings, ITP and manufacturing release approvals | DWGSUB + DWGAPP |
| 5 manufacture, inspections and progress monitoring | MFG |
| 6 witness FAT, NCR closure and FAT acceptance | FAT |
| 7 export, import, inland logistics and delivery | RELEASE + SHIP + CUSTOMS + DELIVER |
| 8 site receipt, inspection, preservation and QA release | — (template) |
| 9 LLE delivered and released for installation | milestone, 0 |

- Steps are identified by their position in the package (1–9), not by name text.
- A step's history duration = the sum of the codes' **p50 working days**, converted to calendar days as
  `ceil(working × 7 / 5)`. A step keeps the template duration when the equipment type has no history
  (Power Modules, Fan Wall Units) or a code has no statistics.
- History used is the package's own equipment type only (all four have 7–9 projects); no fallback to
  "all equipment types".
- **FAT overlap:** the template starts FAT `SS +172` after manufacture starts: with manufacture at 202
  days, FAT starts 30 days before manufacture ends and runs inside it. When manufacture's duration comes
  from history, the FAT link's lag becomes `max(0, manufacture − 30)`, so FAT keeps that position near the
  end of manufacture. All other links and lags are the template's.

### The draft (server)
- `createDraft` for `dc-master` skips the AI (as `skipAi` does today) and builds the draft from the catalog
  with the package durations above. Its `source` is `'history'`.
- Each activity's Basis says where its duration came from:
  - template: **"template"**;
  - history: **"p50 of N projects (Chiller), in calendar days"** (N = that equipment type's project count);
  - milestones as today.
  If the history is sample data, the assumptions say so (as today: "The history is SAMPLE data…").
- Each package activity carries its cost code (new optional `costCode` on the draft activity), so the
  sheet can tag it.
- `request`: `scheduleType 'dc-master'`, `equipmentType ''`, `equipmentName` = the project's name,
  `requiredDate` = the RFS date.

### The wizard
- The Schedule type list shows **All (full project plan)** first for each project type: Data centre →
  `dc-master`, Properties → `property-development` (which today appears as "Property development master
  schedule"; it is listed once, as All). Which schedule types are "full plan" is a fixed list in code.
- With All: one plan, no equipment items; Project is required (as today). The date is labelled **RFS
  date** (Data centre) or **Handover date** (Properties). No notes field effect for Data centre (no AI).
- Preview and sheet use a **7-day calendar** (`workingWeekdays [0…6]`, otherwise the template calendar)
  for `dc-master`; Properties keeps today's calendar.
- Sheet name: **"Full plan – <project name>"** for both.

### The sheet
- One flat sheet (as the Properties master): the template columns plus Activity ID, Lead responsibility,
  Completion / release criteria, Basis; **Project** on every row; **Cost code** and **Delivery site** on
  each package's rows (cost code from the package table; delivery site = the plan's project when it is a
  site, as today); other rows leave them blank. The sheet's calendar is the 7-day calendar.
- Sync with Procore then groups each package's rows as one item (flat sheet).

## Testing
- Catalog: module ↔ migration agree; 199 activities, 22 stages, targets DC-0192, links resolve, no cycles,
  the six packages have 9 steps each in order.
- Packages: history durations summed and converted (`ceil(×7/5)`); fallback to template without history;
  FAT lag follows manufacture; cost codes per package.
- Draft: no AI call for `dc-master` even with an API key; Basis texts; sample-data assumption.
- Backward plan: RFS on the entered date; post-RFS activities after it; 7-day calendar dates.
- Wizard: All listed first for both project types; Properties All = property-development; RFS date label;
  sheet name; package rows tagged.
- e2e: Data centre All → preview → sheet with 199 rows, CHL on chiller package rows.

## Calls left to the builder
- The script's location and form (Python with openpyxl, run once; output committed).
- How the "full plan" list and the date label are expressed in code.
- Exact preview wording of the source ("Built from the Data centre master template and past projects").

## Risks
- The history's step mapping is a judgement; the Basis text makes the source visible so planners can
  correct durations on the sheet.
- 199 rows is the largest plan the wizard has made; preview and sheet creation must stay responsive.
