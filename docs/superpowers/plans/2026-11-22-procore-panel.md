# Plan with AI inside Procore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/procore` page with only sign-in and Plan with AI, embeddable by Procore as a side panel and full screen, opening on the Procore project it was opened in.

**Architecture:** The server lets only Procore's origins frame `/procore`. The page reads the Procore context (address or the side panel's `setup` message), asks a new endpoint to match the Procore project to our project code, and renders the wizard as a page. After Create schedule it offers Open in SmartSheet in a new tab.

**Tech Stack:** React 18 + TypeScript, Node `http` server, Supabase auth, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-22-procore-panel-design.md`

## Global Constraints
- Trusted Procore origins, one list (`src/procore/origins.ts`): `https://app.procore.com`, `https://us02.procore.com`, `https://uk01.procore.com`, `https://sandbox.procore.com`.
- Only the HTML served for path `/procore` (or `/procore/`) gets `Content-Security-Policy: frame-ancestors <origins space-separated>` and no `X-Frame-Options`. Everything else unchanged (`DENY`, `frame-ancestors 'none'`).
- postMessage: send `{ type: 'initialize' }` only when `document.referrer`'s origin is trusted, with that exact `targetOrigin`; accept `message` events only from trusted origins.
- Project match endpoint answers 200 `{ code: string | null, reason?: 'not-configured' | 'other-company' | 'not-found' | 'not-listed' | 'procore-error' }`.
- Don't run Prettier.

## Review Focus
- **A Procore project number that matches a project the caller can't see or that isn't in Procore** → `{ code: null, reason: 'not-listed' }`, no leak of other projects. → Task 2 test `does not match a project the caller cannot read`.
- **The context arrives after the wizard has loaded and after the planner picked a project themselves** → the planner's choice is kept. → Task 4 test `keeps a project the planner chose before the match arrived`.
- **A `setup` message from an untrusted origin** (e.g. a page framing ours via a lookalike host) → ignored. → Task 3 test `ignores messages from other origins`.
- **Non-numeric or missing ids in the address** (`?company=abc`) → treated as no context, no request sent. → Task 3 test `ignores ids that are not numbers`.
- **`/procore` followed by anything else** (`/procore/x`, `/procorex`) → not framable, not the panel page. → Task 1 test `only /procore itself is framable`.

---

### Task 1: Framing rule for `/procore`

**Files:** Create `src/procore/origins.ts`; Modify `server/static.ts`; Test `server/app.test.ts`.

**Interfaces:** Produces `export const PROCORE_ORIGINS: readonly string[]`, `export function isProcoreOrigin(origin: string): boolean`, `export const PROCORE_PANEL_PATH = '/procore'`, `export function isPanelPath(pathname: string): boolean` (true for `/procore` and `/procore/` only).

- [ ] **Step 1: Failing tests** (in `server/app.test.ts`, next to the existing frame test): `lets only Procore frame /procore` — GET `/procore` and `/procore/` → 200 index.html, `content-security-policy` = `frame-ancestors https://app.procore.com https://us02.procore.com https://uk01.procore.com https://sandbox.procore.com`, no `x-frame-options`. `only /procore itself is framable` — `/`, `/procore/x`, `/procorex`, `/assets/<a built asset>` keep `frame-ancestors 'none'` and `X-Frame-Options: DENY`.
- [ ] **Step 2: Run** `npx vitest run server/app.test.ts` → FAIL.
- [ ] **Step 3: Implement**: `send()` takes the frame policy; `serveStatic` passes the Procore policy only when serving index.html for `isPanelPath(decoded)`.
- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `Procore panel: only Procore may frame /procore`.

### Task 2: Match the Procore project

**Files:** Modify `server/procore.ts` (`get`), `server/app.ts` (route), `src/planner/types.ts` (`ProjectMatch`); Test `server/procore.test.ts`, `server/procoreRoute.test.ts`.

**Interfaces:**
- `ProcoreClient.get<T>(path: string, query: Record<string, string>, signal?: AbortSignal): Promise<T>` — one object body (non-object → `ProcoreError('Procore sent an unexpected response.')`), same sign-in/401/rate-limit/timeout behaviour as `getAll`.
- `export interface ProjectMatch { code: string | null; reason?: 'not-configured' | 'other-company' | 'not-found' | 'not-listed' | 'procore-error' }`
- `GET /api/procore/project?company=<digits>&project=<digits>` → `ProjectMatch`.

- [ ] **Step 1: Failing tests:** `get` returns an object and sends `Authorization`/`Procore-Company-Id`; rejects an array body. Route: 401 without token; 400 for non-numeric ids; `not-configured` (200) when no Procore client; `other-company` when `company` ≠ the client's company id; reads `/rest/v1.0/projects/7` with `company_id` and `view=minimal` and answers `{ code: 'BKK-03' }` when `project_number` is `BKK-03` and options list BKK-03; `not-found` when Procore has no `project_number`; `does not match a project the caller cannot read` → `not-listed` when options don't list it; `procore-error` (200) when Procore fails.
- [ ] **Step 2: Run** `npx vitest run server/procore.test.ts server/procoreRoute.test.ts` → FAIL.
- [ ] **Step 3: Implement.** The route does not use the sync limiter (one cheap call). Log `procore.project` with the outcome only.
- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `Procore panel: match the Procore project to ours`.

### Task 3: Procore context in the page

**Files:** Create `src/procore/context.ts`; Test `src/procore/context.test.ts`.

**Interfaces:**
```ts
export interface ProcoreContext { companyId: string; projectId: string }
export function contextFromSearch(search: string): ProcoreContext | null   // ?company=&project=, digits only
export function listenForProcoreContext(win: Window, referrer: string, onContext: (c: ProcoreContext) => void): () => void
```
- [ ] **Step 1: Failing tests:** `contextFromSearch('?company=42&project=7')` → `{ companyId: '42', projectId: '7' }`; `ignores ids that are not numbers` (`?company=abc&project=7`, missing project) → null. `listenForProcoreContext` with a fake window: posts `{ type: 'initialize' }` to `https://app.procore.com` when referrer is `https://app.procore.com/`; posts nothing for another referrer; a `setup` message from that origin with `context.company_id: 42, project_id: 7` calls back with strings; `ignores messages from other origins`; life-cycle messages don't throw; cleanup removes the listener.
- [ ] **Step 2–4:** run → FAIL, implement, run → PASS. **Step 5: Commit** `Procore panel: read the Procore context`.

### Task 4: The wizard as a page, with an initial project

**Files:** Modify `src/planner/PlannerWizard.tsx`, `src/planner/plannerWizard.css`; Test `src/planner/PlannerWizard.test.tsx`.

**Interfaces:** `PlannerWizardProps` gains `embedded?: boolean` (no backdrop, no close button, Escape does nothing, fills its container; root keeps `role="dialog"` off — use `role="region"` with the same label) and `initialProject?: string` (a project code).
- [ ] **Step 1: Failing tests:** embedded renders no Close button and no backdrop; `applies the initial project and its project type` (options with BKK-03 data-centre and VIL-01 properties; `initialProject="VIL-01"` → Project type `properties`, Project `VIL-01`); applies it when it arrives after options loaded (rerender with the prop); `keeps a project the planner chose before the match arrived`; an unknown code changes nothing.
- [ ] **Step 2–4:** run → FAIL, implement (apply once per distinct code, only while the planner hasn't chosen a project), run → PASS; CSS: `.planner-wizard.is-embedded` fills the page (no max height/border radius); the preview table wrapper scrolls horizontally at ≤ 480 px.
- [ ] **Step 5: Commit** `Procore panel: the wizard as a page, with an initial project`.

### Task 5: The `/procore` page

**Files:** Create `src/procore/ProcorePanelPage.tsx`, `src/procore/procorePanel.css`; Modify `src/main.tsx`, `src/planner/plannerApi.ts` (`requestProjectMatch(token, ctx, opts)` → `ProjectMatch`); Test `src/procore/ProcorePanelPage.test.tsx`, `src/planner/plannerApi.test.ts`.

**Interfaces:** `export function ProcorePanelPage({ client, location }: { client: SupabaseClient; location: Pick<Location, 'search' | 'origin' | 'href'> })`; `export function storageAvailable(storage?: Storage): boolean`.
- [ ] **Step 1: Failing tests:** signed out → the sign-in form only; signed in → Plan with AI embedded, no app header; with `?company=42&project=7` it calls `requestProjectMatch` and passes `initialProject='BKK-03'`; after `onCreated('s1')` shows `Schedule created` with a link `Open in SmartSheet` to `<origin>/?sheet=s1` (`target="_blank"`, `rel="noopener"`) and `Plan another` which shows the wizard again; when storage is unavailable shows `Your browser blocks sign-in inside Procore.` with a link `Open Plan with AI in a new tab` to the same address (`target="_blank"`).
- [ ] **Step 2–4:** run → FAIL, implement (main.tsx routes `isPanelPath(location.pathname)` to a lazy `ProcorePanelPage` with its own client from `getSupabaseConfig`), run → PASS; `npx vitest run` and `npx tsc -b` green.
- [ ] **Step 5: Commit** `Procore panel: the /procore page`.

### Task 6: End to end and setup guide

**Files:** Modify `e2e/planner.spec.ts`; Create `docs/procore-app-setup.md`.
- [ ] **Step 1:** e2e `Plan with AI in a Procore side panel`: 400×900 viewport, stub options (BKK-03), stub `**/api/procore/project**` → `{ code: 'BKK-03' }`, open `/procore?company=42&project=7`, sign in as the fake user, expect Project `BKK-03`, no horizontal page scroll, generate and create (stubs as the Data centre All e2e), expect `Schedule created` and the Open in SmartSheet link.
- [ ] **Step 2:** `docs/procore-app-setup.md`: Developer Portal steps (new version of the same app as the sync; Side Panel External URL `https://smartsheet-web-production.up.railway.app/procore?view=panel` with views `schedule.calendar.list`, `schedule.calendar.month.list`, `schedule.calendar.task.list`, `schedule.calendar.lookaheads.list`, `schedule.calendar.task.detail`, `commitments.work_order_contracts.detail`, `commitments.purchase_order_contracts.detail`, `commitments.contracts.list`, `budgeting.list`, `budgeting.detail`, `budgeting.forecasting.detail`; Full Screen External URL `…/procore?company={{procore.company.id}}&project={{procore.project.id}}`), sandbox install, renumbering a sandbox project to BKK-03, the two sandbox checks.
- [ ] **Step 3:** run the planner e2e → all pass. **Commit** `Procore panel: e2e and setup guide`.

## Not in this plan
- Cost code from the commitment the panel was opened on.
