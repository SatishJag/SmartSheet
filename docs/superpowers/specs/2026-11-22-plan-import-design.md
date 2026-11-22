# Plan with AI: import a plan from Excel — design

Date: 2026-11-22. Status: agreed with the owner (grilling rounds 1–5, approach 2); written for building.

## Why
Planners keep their project plans as Excel templates (sample: `Property_Development_Schedule_Template.xlsx`,
the Property department's 44-activity master schedule with a "Basis of Plan" sheet). They want to upload
that file in Plan with AI and have the AI understand it and create the plan in this app, instead of
re-entering it. The planner's own content must survive exactly; the AI only makes judgement calls and
fills gaps, and the planner confirms its guesses before anything is created. Later the same wizard runs
inside Procore's side panel (separate design), so the import lives in the wizard itself.

## Goals
- Upload `.xlsx` or `.csv` (≤ 10 MB, ≤ 500 activities) from the top of the Plan with AI request step.
- Keep from the file, exactly: activity ID, name, stage/WBS, activity vs milestone, lead responsibility,
  completion criteria, predecessors (`P080 FS; P090 SS`, with lags like `SS+5`; "Project start" = none),
  given durations, status.
- Fill blank durations: from the matched schedule type's catalog/history for template activities; an AI
  estimate for activities the planner added. Every filled duration says where it came from in Basis.
- Detect schedule type, project and handover date; the planner confirms or corrects each on a
  "What we found" step; the project stays required (when projects are on offer).
- Same preview as today, then Create makes one sheet (flat, like a single-item plan).

## Non-goals
Importing several plans from one file; keeping the file; per-activity date constraints (dates only feed
durations); Forecast finish; resource or cost columns; the Procore side panel and sync (separate designs);
changing the existing "Import CSV" on the Sheets page (stays a plain import).

## Anti-goals
- The AI rewriting, merging, dropping or renaming the planner's activities or links.
- Creating anything the planner did not confirm.
- A wrong guess (project, schedule type, date) passing silently.

## Approaches (owner chose 2)
1. AI reads the whole file and returns the plan: simplest, but the planner's data passes through the
   model (silent changes on hundreds of rows), slow and costly, long replies can truncate.
2. **A deterministic reader copies; the AI only judges (chosen).** The reader finds the table by its
   headings, copies rows exactly, parses predecessors and the Basis of Plan fields. The AI maps unknown
   headings (from headings + a few sample rows), and estimates durations for added activities (names and
   stages only). Schedule type and project are matched deterministically first.
3. Reader only, fixed mapping: breaks on other layouts, no estimates. Rejected.

## Decisions (owner)
Q2/Q3/Q15–Q25 and Q4/Q7 as revised: every sheet is read; content sent to the AI is minimal and not kept;
≤ 500 activities; handover date from the file else asked; "To plan"/blank → Not started, clear matches
carry over, unclear → Not started; unknown layout → AI maps columns, no activity list → say so, create
nothing; file matching no known template → general schedule; one import = one AI draft against the
hourly limit; 10 MB.

## Design

### Reading the file (browser)
- `.csv` via the existing `parseCsv`; `.xlsx` via the `read-excel-file` library (all sheets, cell values as
  text, dates as ISO `YYYY-MM-DD`), loaded with a dynamic `import()` so it is not in the main bundle.
- Result: `Workbook = { fileName; sheets: { name: string; rows: string[][] }[] }`.

### Finding the activity table (browser, deterministic)
- For each sheet, scan the first 30 rows for a heading row. Known headings (case/space-insensitive,
  synonyms allowed) map to fields: `activityId` (Activity ID, ID, Code), `name` (Activity or milestone,
  Activity, Task, Description), `phase` (Stage / WBS, Stage, WBS, Phase), `kind` (Type), `responsibility`
  (Lead responsibility, Responsibility, Owner), `duration` (Duration (days), Duration), `start` (Baseline
  start, Start), `finish` (Baseline finish, Finish), `status` (Status), `predecessors` (Reference
  predecessors, Predecessors), `criteria` (Completion / release criteria, Criteria).
- A heading row counts when it maps `name` plus at least two other fields. The sheet with the most
  mapped fields wins; ties → the one with more data rows.
- No heading row found anywhere → ask the server to map columns (below) from the first 30 rows of each
  sheet (max 5 sheets). Still nothing → "No list of activities found in this file", nothing created.
- Rows after the heading row are activities until the end; blank rows are skipped; a row without a name
  is skipped. Activity ID missing → generated `A001…` in row order (links then can only use IDs present).
- More than 500 activities → refuse with a clear message.

### Parsing a row
- `kind`: "Milestone" (case-insensitive, or duration 0 with no start/finish span) → milestone.
- `duration`: a non-negative number → kept (milestone → 0). Blank + both start and finish dates → working
  days between them on the sheet calendar (inclusive), basis "from your file's dates". Otherwise blank.
- `predecessors`: split on `;` or `,`; each `CODE [FS|SS|FF|SF][±N[d]]`, type default FS, lag in working
  days; "Project start"/blank → none. Unknown codes and self-links are dropped with a warning.
- `status`: "To plan"/"Not started"/blank → Not started; "In progress"/"Started"/"Ongoing" → In progress;
  "Complete"/"Completed"/"Done" → Complete; anything else → Not started (warning). Use the sheet
  template's exact status option strings.

### Basis of Plan (browser, deterministic)
- Any sheet whose rows are mostly two-column label/value pairs: read `label → value`. Recognised labels:
  "Project name", "Project code / location" (project), "Target construction start / handover" (dates).
- Project guess: a known project code that appears (whole word) in those values, else in the file name
  or sheet names. Handover guess: the last ISO date found in a handover-labelled value.

### Server: `POST /api/planner/import` (auth like the other planner calls)
Body (only what the AI needs; never the whole file):
`{ columns?: { sheet: string; rows: string[][] }[], activities?: { code, name, phase }[], hints: { fileName, sheetNames, basis: Record<string,string> } }`
- `columns` present (unknown layout): the AI returns a heading→field mapping for the table it finds, or
  "none". Response `{ ok: true, mapping: { sheet, headingRow, fields: Record<field, columnIndex> } | null }`.
- `activities` present: the server
  1. matches the schedule type: the catalog whose codes (or names, case-insensitive) cover the most file
     activities, at least 50% → that type; else none (general schedule);
  2. for blank-duration activities found in that catalog: the duration and basis the history draft would
     use (statistic, or catalog default);
  3. for the rest with blank durations: one AI call returning `{ code, days, reason }` per activity
     (integer days ≥ 1; milestones 0), validated; on AI failure → 5 working days each with basis
     "default: no AI estimate available".
  Response `{ ok: true, scheduleType: string | null, durations: { code, days, basis: 'history' | 'template' | 'estimate', reason }[], history: HistorySummary | null }`.
- Counts as one draft against the per-user hourly limit and in-flight limit (existing limiter); 429 as
  today when over.
- Nothing from the request is stored or logged beyond counts.

### The draft
- Built in the browser from the copied activities + server durations into a `PlanDraft`:
  `request = { scheduleType: <confirmed type or 'imported'>, equipmentType: '', equipmentName: <project
  name or file name>, requiredDate: <confirmed handover> }`, `source: 'history'`, links from the file.
- `DurationBasis` gains `'file' | 'estimate'`; Basis text: file → "from your file"; file dates → "from your
  file's dates"; template → "from the template, no history yet"; history → as today; estimate →
  "AI estimate: <reason>". Activities keep `activityId`, `responsibility`, `criteria`, and a new optional
  `status` written to the sheet's Status column (default Not started).
- Target (the finish that lands on the handover date): the matched catalog's target code if present in
  the file (P420 for property development); else the single activity with no successors; else the last
  row.
- Errors before preview: a dependency cycle or a plan the engine cannot schedule → shown on "What we
  found" with the activities involved; nothing created.

### Wizard
- Request step: an "Import from Excel" button at the top (file input accepting `.xlsx,.csv`).
- After reading + the server call: a **"What we found"** step with editable Project type, Schedule type
  (or "General schedule"), Project (required when listed), Planned handover (required), and a summary
  ("44 activities: 12 durations from your file, 32 filled in", warnings list). Buttons: Back to the form,
  Preview.
- Preview: the existing single-plan preview of the draft. Create: `insertSheetFromDrafts` with the one
  draft, Project column as today; no cost code or delivery site columns for imports.
- A new upload replaces the previous import. Leaving the import (Back) returns to the normal form.

## Answers after the builder check
- **Schedule type corrected on "What we found"** (directly, or because the project type changed):
  the browser calls `/api/planner/import` again with `scheduleType: <chosen id> | null` in the body;
  the server then uses that type instead of matching. Durations, target and Basis always come from the
  confirmed type. *(Coordinator's call.)*
- **Preview for imports**: the per-item and "Regenerate all" controls are hidden (they would redraft
  from the catalog and replace the planner's activities). Back from the preview returns to "What we
  found". *(Coordinator's call.)*
- **Hourly limit**: a server call counts one draft only when it actually calls the AI (column mapping,
  or estimating added activities). A known layout costs at most one draft; an unknown layout can cost
  two. Every call takes an in-flight slot. *(Coordinator's call; keeps file content from reaching the
  AI without a cap.)*
- **No predecessors** (owner, Q26 = a): activities whose code matches the confirmed template, and have
  no predecessors in the file, get the template's default links; Basis and the warnings say "links from
  the template". Added activities without predecessors stay unlinked, with a warning. A file that does
  give predecessors for an activity always wins.
- **Request size**: `/api/planner/import` accepts bodies up to 1 MB (500 activities); the other planner
  routes keep their limit.
- Status strings other than the mapped ones (e.g. "On hold") carry over only when the sheet's Status
  column offers them; otherwise Not started with a warning. Duplicate activity IDs: the first row keeps
  the ID, later duplicates get `<ID>-2`, `<ID>-3` with a warning.

## Left to the builder
File/module layout; exact synonym lists beyond those above; the AI prompt wording; the warnings' wording;
UI styling within the existing wizard look.
