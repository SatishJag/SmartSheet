# Cost code on Plan with AI items: design

Date: 2026-11-21. Status: agreed with the owner (grill session), not built yet.

## Why
A long-lead equipment plan made with Plan with AI has to be traced back to the money in Procore: the
budget line (cost code) it spends against and, after award, the commitment (PO) against that line.
Today the generated sheet identifies an item only by its free-text type and name, so linking it later
would mean matching "Diesel generator" to "Diesel generator, 2.5 MVA" by eye on every project.

The schedule starts at specification and tender, before any PO exists, so the PO number cannot be the
link key. The Procore budget (with cost codes) does exist before tender, so the **cost code** is the
key, and it is known when the plan is generated. The chain is:

`schedule item  ->  cost code (known from day one)  ->  commitment / PO (known at award)`

This MVP records the first link only. Everything that talks to Procore comes later.

## Decisions (owner's answers)
1. **Link key is the Procore cost code.** The budget with cost codes exists before tender.
2. **Cost codes are a mix**: big items have their own code, smaller ones may share one. So a cost
   code is a grouping field, not a unique id: several items may carry the same code.
3. **No Procore sync in the MVP.** The user picks a cost code and it is saved; nothing is read from
   or written to Procore. (When sync comes, it is pull-only: Procore owns money and POs, the
   schedule owns dates.)
4. **The cost code list is a fixed company list** (same on every project, does not change for the
   MVP), loaded once into a database table by a migration, like the property development template
   (`supabase/migrations/0018_property_development.sql`).
5. **The table holds all 15 Procore codes, with an `in_planner` flag.** Only flagged codes are
   offered anywhere in the app. For the MVP exactly five are flagged (below).
6. **Picked in both places**: an optional field on each item in the wizard (step 1, Request), and a
   Cost code dropdown column on every generated sheet, where it can be filled in or changed later.
7. **Auto-fill, editable.** Choosing an equipment type that has a code fills the item's cost code.
   Changing the type changes the code too, **unless the user has edited the code by hand**; a code
   the user chose is never overwritten.

## The cost code list
Copied exactly from Procore (Project Settings > Work Breakdown Structure > Cost Code), spelling
included ("Colling Tower", "HV SiwtchGear"): the code is the key a later sync matches on, and
spelling fixes belong in Procore.

| Code | Description | in_planner | Equipment type it fills for |
|---|---|---|---|
| ADV | Advance Payment | no | |
| ADV-REC | Advance Payment Recovery | no | |
| AUH | Authority | no | |
| CHL | Chiller | **yes** | Chiller |
| CLT | Colling Tower | no | |
| CONS | Consultancy Fees | no | |
| CRAC | CRAC/CRAH/FWU | no | |
| CSA | Civil & Structural | no | |
| DU | Coolant & Distribution Unit | no | |
| ELE | Elevator | **yes** | Elevator |
| GEN | Generator | **yes** | Diesel generator |
| HVS | HV SiwtchGear | **yes** | HV switchgear |
| POW | Power Skid | no | |
| TRF | Transformer | **yes** | Power transformer |
| UPS | UPS & Battery System | no | |

The equipment type names in the last column must match the planner's equipment types exactly (the
`equipment_type` values in `history_projects`, shown as the wizard's cards).

## Behaviour

### Wizard (step 1, Request)
- Each item row gets a fourth field, **Cost code**, after Required on site: a single-choice
  dropdown of the flagged codes, shown as `CODE — Description` (e.g. `GEN — Generator`), plus an
  empty choice. Optional: an empty cost code never blocks Generate.
- Ticking a card adds its item with the mapped code already chosen.
- Changing an item's equipment type: if the code was not edited by hand, it becomes the new type's
  code (or empty when the type has none). If it was edited by hand, it stays.
- Clearing the code by hand counts as an edit (it stays empty when the type changes).
- An item with a typed-in type ("type it yourself") starts with an empty code. The user may still
  pick one of the five.
- The cost code is **not sent to the AI** and does not affect the plan. It travels client-side with
  the item (by item key, like the item's notes) to the sheet.

### Generated sheet
- Every sheet Plan with AI creates gets a **Cost code** column: Dropdown (single), options = the
  flagged codes as `CODE — Description`, placed just before **Basis**.
- The dropdown is strict (only the listed options are accepted, `src/model/validate.ts`), so the
  column holds one of the five or nothing.
- Which row carries the code:
  - Several items: the item's **summary (parent) row** only. Its activity rows stay empty.
  - One item (flat sheet, no summary row): **every activity row** carries it, since all rows
    belong to that one item. *(Coordinator's call; the owner can change it.)*
- Items without a code leave the cell empty.
- After creation it is an ordinary dropdown column: users can fill in, change or clear codes, and
  the column's options can be edited like any other dropdown.

### When the list cannot be loaded
If the cost code list fails to load, the wizard hides the Cost code field and the sheet is created
without the column. Planning never fails because of cost codes.

## Data
Migration `0019_cost_codes.sql`:

```
cost_codes
  code           text primary key   -- 'GEN', exactly as in Procore
  description    text not null      -- 'Generator', exactly as in Procore
  in_planner     boolean not null default false
  equipment_type text null unique   -- planner equipment type it auto-fills for, e.g. 'Diesel generator'
```

- Seeded with the 15 rows above.
- Read-only reference data: `select` for authenticated users, no insert/update/delete from the app,
  under the same grants as `schedule_types` and the other planner reference tables.
- Changing which codes are offered later = flip `in_planner` (and set `equipment_type`) in a new
  migration; no app code change.

The sheet stores the display text (`GEN — Generator`) in the cell. The code is the part before
` — `, which a later sync parses. Option text must not contain commas (`normalizeOptions`); none of
the five does.

## Not in the MVP
- Any Procore connection: no API, no OAuth app, no sync button.
- Reading commitments/POs, PO number, status, committed amount or vendor onto the sheet.
- Importing a Procore commitments export.
- Matching an item to a PO when several items share a cost code.
- Cost types / full budget codes (cost code + cost type), sub jobs.
- Per-company or per-project cost code lists; an admin screen to upload or edit codes.
- The other 10 codes in the dropdown.

## Later (phase 2, for reference only)
1. Commitments export upload (no Procore approval needed), matched to items by cost code; a PO
   number field per item resolves items that share a code.
2. Read-only Procore API pull of commitments, Schedule of Values lines and cost codes, replacing the
   upload and refreshing `cost_codes`.
3. Optionally push schedule dates (award, required on site, forecast delivery) back to Procore.

## Parts
1. Migration `0019_cost_codes.sql`: table, seed, grants, RLS.
2. `src/planner/costCodes.ts`: load the flagged codes; option text; code for
   an equipment type (pure, tested).
3. `src/planner/plannerItems.ts`: `costCode` and `costCodeEdited` on `ItemForm`; auto-fill on card
   tick and type change, respecting the edited flag (pure, tested). `JobItem` carries the code by key.
4. `src/planner/PlannerWizard.tsx`: the Cost code field per item; hidden when the list did not load.
5. `src/planner/sheetFromDraft.ts`: the Cost code dropdown column before Basis; the code on the
   summary row (several items) or on every row (one item) (tested).
6. Tests: unit tests for 2, 3 and 5; a wizard test for auto-fill and the edited flag; an e2e check
   that a generated sheet shows the codes.

---

# Addendum: Procore project on the plan

Date: 2026-11-21. Status: agreed with the owner (grill session, Q10–Q15), not built yet.

## Why
In Procore a budget line is **project + cost code**: `CHL` alone does not say which budget it
spends against. Data centre long-lead equipment is bought at **program level**: a program (dummy)
project in Procore owns the budget and the batch POs, and the equipment is later delivered to the
real sites. So a plan also needs the Procore project it is bought against.

## Decisions (owner's answers)
1. **One project per plan** (Q10), chosen at the top of the wizard. Every item in the plan is bought
   against it; each item keeps its own cost code.
2. **The program project uses the same 15 company cost codes** (Q11), so the cost code work above
   stands unchanged; a budget line is e.g. `PRG-DC-01 / CHL`.
3. **The list holds program and site projects, program projects first** (Q12).
4. **Only real Procore projects are listed** (Q13). The program project does not exist in Procore
   yet, so the seed is `BKK-03 — Bangkok 3` only; the program project is added by a later migration
   (`is_program = true`) once it exists. No placeholder codes.
5. **Optional, starts empty** (Q14): the dropdown starts on **None**; nothing is pre-selected, even
   when only one project is on offer, and an empty project never blocks Generate.
6. **A "Procore project" dropdown column next to Cost code** on the generated sheet (Q15), filled on
   the same rows as the cost code.

## Data
Migration `0020_procore_projects.sql`, same pattern and grants as `cost_codes` (read-only for signed-in
users, closed to anon, no writes through the API):

```
procore_projects
  code        text primary key   -- 'BKK-03', exactly as in Procore
  name        text not null      -- 'Bangkok 3', exactly as in Procore; no commas
  is_program  boolean not null default false
  in_planner  boolean not null default true
```

Seed: `('BKK-03', 'Bangkok 3', false, true)`.

## Behaviour
- **Wizard:** a **Procore project** select right after **Schedule type**: **None**, then
  `CODE — Name` for each `in_planner` project, program projects first, then by code. Changing project
  type or schedule type keeps the choice. Hidden when the list is empty or could not be loaded.
- **Not sent to the AI**, like the cost code.
- **Sheet:** a `Procore project` PICKLIST column (options = the offered projects as `CODE — Name`)
  immediately before `Cost code` (before `Basis` when there is no Cost code column). Same rows as the
  cost code: every summary row when there are several items, every row when there is one. Empty when
  None was chosen. The column is added whenever the list loaded, even if None was chosen, so the
  project can be filled in later.

## Not in scope
Delivery site per item (where program-bought equipment ends up), allocating a batch to sites,
per-project cost code lists, a project admin screen, any Procore sync.
