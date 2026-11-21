# Delivery site per item: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each Plan with AI item gets an optional Delivery site. The choices are the site projects from the Procore project list. The site defaults to the plan's project when that project is a site, and it lands in a "Delivery site" column on every row of the item.

**Architecture:** No database change: sites are `PlannerOptions.procoreProjects` with `isProgram === false`.
- **Form item:** gains `deliverySite` and `deliverySiteEdited`. One pure function keeps unedited items in step with the plan's default site, the same rule as cost codes.
- **Sheet builder:** gets a third tag column, written on every row of each item.
- **Item row:** moves Cost code and Delivery site into a second line, a sub-grid of their own.

**Tech Stack:** TypeScript, React 18, Vitest + Testing Library, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-11-21-cost-code-link-design.md`, the section "Addendum: Delivery site per item".

## Global Constraints

- **The list:** sites are the Procore projects with `isProgram === false`, in the order received. Option text is `` `${code} — ${name}` `` (from `projectOption`), e.g. `BKK-03 — Bangkok 3`.
- **The field:** labelled **Delivery site**. It is optional, starts empty (**None**) and is never sent to `/api/planner/*`. It is hidden when no site is on offer.
- **The default:** when the plan's Procore project is a site, an item whose site was not edited by hand takes that site. A program project or None gives `''`. A site picked or cleared by hand never changes again.
- **The column:** titled **`Delivery site`**, type `PICKLIST`, options = the sites' option text. It sits after `Cost code`, so the end of the column list reads: `Procore project`, `Cost code`, `Delivery site`, `Basis`. Without the other columns it still sits just before `Basis`. It is added when at least one site is on offer.
- **Rows:** the value goes on **every row of the item**: the summary row and all its activities when there are several items, every row when there is one. A value not among the options is left empty.
- **Item row:** line 1 holds Equipment type, Equipment name, Required on site and Remove. Line 2 holds Cost code then Delivery site, and is shown only when at least one of them is on offer. On a phone the fields stack.
- **Layout check:** the Equipment name stays at least 150 px wide at every width the existing e2e test checks.

## Review Focus

1. **The plan's project switches from a site to the program, or to None, after items were defaulted:** unedited items clear, and items edited by hand keep their site. Pinned in Task 1 and Task 3.
2. **An item added after the project was chosen** (a card ticked later) gets the default site. Pinned in Task 3.
3. **Only the program project is on offer** (no sites): there is no Delivery site field and no column, and Cost code still shows on line 2. Pinned in Task 2 and Task 3.
4. **Filtering by site would miss activities:** activity rows carry the site, not just summary rows. Pinned in Task 2.
5. **Rows with neither cost codes nor sites** look exactly as they did before (no empty second line). Pinned in Task 3 (e2e).

---

### Task 1: Delivery site on the form item

**Files:**
- Modify: `src/planner/plannerItems.ts`, `src/planner/procoreProjects.ts`
- Test: `src/planner/plannerItems.test.ts`, `src/planner/procoreProjects.test.ts`

**Interfaces:**
- Produces:
  - `ItemForm.deliverySite: string` (a project code, or `''`) and `ItemForm.deliverySiteEdited: boolean`. `newItem` sets them to `''` and `false`.
  - `syncDeliverySites(items: ItemForm[], defaultSite: string): ItemForm[]`. Every item with `deliverySiteEdited === false` gets `deliverySite = defaultSite`. It returns **the same array** when nothing changes.
  - `setDeliverySite(item: ItemForm, code: string): ItemForm` returns `{ ...item, deliverySite: code, deliverySiteEdited: true }`. Clearing to `''` also counts as edited.
  - In `procoreProjects.ts`:
    - `siteProjects(projects: readonly ProcoreProject[]): ProcoreProject[]`, the non-programs in the order received;
    - `defaultDeliverySite(projects: readonly ProcoreProject[], planProject: string): string`, which returns `planProject` when it is the code of a site on offer, else `''`.
  - `jobFromForm` is unchanged: no site in the Job.

- [ ] **Step 1: Write the failing tests**
  - `plannerItems.test.ts`, in a new `describe('delivery sites')`:
    - `'starts a new item with no site, unedited'`
    - `'gives unedited items the default site'`: `syncDeliverySites([newItem('Chiller')], 'BKK-03')[0].deliverySite` is `'BKK-03'`
    - `'follows the default when it changes, including to none'`: `'BKK-03'` then `''`
    - `'keeps a site picked by hand'`: `setDeliverySite(item, 'BKK-03')`, then sync with `''`, still gives `'BKK-03'`
    - `'keeps a site cleared by hand'`: `setDeliverySite(item, '')`, then sync with `'BKK-03'`, still gives `''`
    - `'returns the same array when nothing changes'`
    - `'does not put the site in the job'`
  - `procoreProjects.test.ts`, with `[PRG (isProgram true), BKK-03, SIN-01]`:
    - `siteProjects` gives `['BKK-03', 'SIN-01']` (codes)
    - `defaultDeliverySite(..., 'BKK-03')` is `'BKK-03'`
    - `defaultDeliverySite(..., 'PRG-DC-01')` is `''`
    - `defaultDeliverySite(..., '')` is `''`
    - `defaultDeliverySite(..., 'XYZ')` is `''`
- [ ] **Step 2: Run them and check they fail.** Run `npx vitest run src/planner/plannerItems.test.ts src/planner/procoreProjects.test.ts`. Expected: FAIL, the functions are not defined.
- [ ] **Step 3: Implement** in the two files. `isPristine` is unchanged.
- [ ] **Step 4: Run them and check they pass.** Run the same command, plus `src/planner/plannerEntries.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `Plan with AI: delivery site on each item, defaulting to the plan's site`.

---

### Task 2: Delivery site column on the generated sheet

**Files:**
- Modify: `src/planner/sheetFromDraft.ts`
- Test: `src/planner/sheetFromDraft.test.ts`

**Interfaces:**
- Consumes: the existing `CostCodeColumn`, `ProjectColumn`, `tagCells` and `activityRows(..., tags)`.
- Produces:
  - `export const DELIVERY_SITE_COLUMN_TITLE = 'Delivery site'`
  - `export interface DeliverySiteColumn { options: string[]; values: (string | undefined)[] }`, where `values[i]` is draft `i`'s option text
  - `buildSheetFromDraft(draft, plan, ownerId, calendar, costCodes?, project?, deliverySites?: DeliverySiteColumn)`
  - `buildSheetFromDrafts(items, ownerId, calendar, costCodes?, project?, deliverySites?: DeliverySiteColumn)`
  - `insertSheetFromDrafts(..., options: { today?; costCodes?; project?; deliverySites?: DeliverySiteColumn })`
- Rules: see Global Constraints (column placement, every row of the item, values not among the options dropped).

- [ ] **Step 1: Write the failing tests** in a new `describe('Delivery site column')`, reusing the Cost code / Procore project fixtures. With `S: DeliverySiteColumn = { options: ['BKK-03 — Bangkok 3', 'SIN-01 — Singapore 1'], values: ['BKK-03 — Bangkok 3', undefined, 'SIN-01 — Singapore 1'] }`:
  - `'adds a strict Delivery site dropdown after Cost code'`: with `CC`, `P`, `S`, the column order ends `['Procore project', 'Cost code', 'Delivery site', 'Basis']`, and the new column is a `PICKLIST` with `S.options`.
  - `'goes just before Basis on its own'`: with `undefined, undefined, S`, the order ends `['Delivery site', 'Basis']`.
  - `'puts each item’s site on its summary row and on every one of its activities'`: for summary `i`, it and every child of `i` hold `S.values[i]`. For the middle item, every row is `undefined`.
  - `'puts a single item’s site on every row'`
  - `'ignores a value that is not one of the options'`
  - `'adds no column without sites'`: `undefined`, and also `{ options: [], values: [] }`
  - `'keeps the cost code and project on summary rows only'`: with all three, child rows still hold no Cost code or Procore project value. This guards the shared helper.
  - `'saves the column and the sites, and they load back'`, through `insertSheetFromDrafts(..., { deliverySites: S })`
- [ ] **Step 2: Run them and check they fail.** Run `npx vitest run src/planner/sheetFromDraft.test.ts -t "Delivery site"`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `newPlanSheet` takes `siteOptions: string[] = []` and places the column after `costCodeColumn`.
  - `cols.deliverySite` holds the column id.
  - `deliverySiteValue(deliverySites, i)` mirrors `costCodeValue`.
  - In the multi-item path, the summary row gets `tagCells` plus the site, and children get `activityRows(..., { [cols.deliverySite]: site })` when the site is set.
  - In the single-item path, the site joins the existing tags on every row.
- [ ] **Step 4: Run them and check they pass.** Run `npx vitest run src/planner/sheetFromDraft.test.ts src/planner/plannerChain.integration.test.ts`. Expected: PASS, with all earlier column tests unchanged.
- [ ] **Step 5: Commit** with the message `Plan with AI: Delivery site column on every row of each item`.

---

### Task 3: The wizard field, the two-line item row, and Create

**Files:**
- Modify: `src/planner/PlannerWizard.tsx`, `src/planner/plannerWizard.css`
- Test: `src/planner/PlannerWizard.test.tsx`, `e2e/planner.spec.ts`

**Interfaces:**
- Consumes: `syncDeliverySites`, `setDeliverySite`, `siteProjects`, `defaultDeliverySite` (Task 1); `projectOption`, `optionForProject` (existing); `insertSheetFromDrafts(..., { deliverySites })` (Task 2).
- Behaviour:
  - `const sites = siteProjects(procoreProjects)`, memoised on `options` so the effect below doesn't loop.
  - A sync effect beside the cost code one runs `setItems((prev) => syncDeliverySites(prev, defaultDeliverySite(procoreProjects, procoreProject)))`, depending on `[items, procoreProject, options]`.
  - `ItemFields` gets `sites: readonly ProcoreProject[]` and `onDeliverySite(code: string)`. Each change goes through `setDeliverySite`.
  - **Markup:** Cost code and Delivery site move into one `<div className="planner-item-tags">` placed after the date field, in that order. The div renders only when cost codes or sites are on offer.
  - **The Delivery site field:** a select labelled **Delivery site**, id `${idBase}-site`, with **None** then one option per site using `projectOption`. It renders only when `sites.length > 0`.
  - **Row classes:** the row gets `has-tags` (replacing `has-code`) when the tags div renders.
  - **CSS:**
    - Delete every `.has-code` rule, including the 1100 px media block.
    - Add a `tags` grid area on its own line after the existing areas: `'type name date' 'tags tags tags'`, and with an index `'idx type name date rm' '. tags tags tags .'`. Keep the `has-other` and `no-select` variants and both narrow-screen blocks consistent.
    - `.planner-item-tags` is a grid of two `minmax(0, 260px)` columns with a 12 px gap. It becomes one column under 640 px.
  - **`create()`:** pass `deliverySites = sites.length > 0 ? { options: sites.map(projectOption), values: entries.map((e) => optionForProject(sites, items.find((i) => i.key === e.key)?.deliverySite ?? '')) } : undefined`.

- [ ] **Step 1: Write the failing tests** in `PlannerWizard.test.tsx`, a new `describe('PlannerWizard: delivery site')`. Use `OPTIONS_S = { ...OPTIONS, costCodes: […TRF, HVS], procoreProjects: [PRG-DC-01 (program), BKK-03, SIN-01] }`.
  - `'offers the sites only, starting on None, on the second line after the cost code'`:
    - the options are `['None', 'BKK-03 — Bangkok 3', 'SIN-01 — Singapore 1']`;
    - the Delivery site select follows the Cost code select in document order.
  - `'defaults every unedited item to the plan’s project when it is a site, and follows it'`:
    - pick `BKK-03` as the Procore project, and both items show `BKK-03`;
    - pick `PRG-DC-01`, and both show `''`.
  - `'keeps a site picked by hand when the plan’s project changes'`
  - `'gives an item ticked later the default site'`: pick `BKK-03`, then tick a card, and the new item shows `BKK-03`.
  - `'does not send the site to the planning server'`: no `BKK-03` or `SIN-01` appears in `JSON.stringify(batches)`. Leave the Procore project on None and pick the sites by hand, so the project field can't leak them either.
  - `'creates the sheet with the site on every row of each item'`:
    - item 1 is `SIN-01` and item 2 is None;
    - the `Delivery site` column comes right after `Cost code`;
    - item 1's summary row and all its children hold `'SIN-01 — Singapore 1'`;
    - item 2's rows are empty.
  - `'hides the field and adds no column when only the program project is on offer'`: `procoreProjects: [PRG-DC-01]`. The Cost code field is still shown.
- [ ] **Step 2: Run them and check they fail.** Run `npx vitest run src/planner/PlannerWizard.test.tsx -t "delivery site"`. Expected: FAIL, no Delivery site field.
- [ ] **Step 3: Implement** as described under Behaviour.
- [ ] **Step 4: Run them and check they pass.** Run `npx vitest run src/planner`. Expected: PASS, including every earlier Cost code and Procore project test.
- [ ] **Step 5: Extend the e2e tests** in `e2e/planner.spec.ts`:
  - **Multi-item test:** add sites to its options. Choose `BKK-03` as the Procore project, so both items default to `BKK-03`. After Create, rows 1, 2 and 16 show `'BKK-03 — Bangkok 3'` in `Delivery site`.
  - **Name-width test:** add a site to its options. It must still pass at every listed width, and also check that the Delivery site select's top is below the Equipment name input's bottom (it's on line 2).
  - **Phone test:** add a site to its options. Check there is still no sideways scroll.
  - **New test, `'Plan with AI: an item row without cost codes or sites stays on one line'`:** with plain `OPTIONS`, the item row's height is less than 110 px.

  Run: `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npm run test:e2e -- e2e/planner.spec.ts --trace off`. Expected: all pass.
- [ ] **Step 6: Full check, then commit.** Run `npm test && npx tsc -b`; expected: green. Commit with the message `Plan with AI: delivery site per item, on a second line with the cost code`.
