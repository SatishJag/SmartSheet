# Procore sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A **Sync with Procore** button on Plan with AI sheets fills **Committed (Procore)** and **Awarded** per project + cost code, read-only from Procore.

**Architecture:** A small server-side Procore client (client-credentials sign-in, pagination, rate limits) feeds a pure per-cost-code aggregation behind `POST /api/procore/committed`. The browser collects the sheet's project + cost code pairs, calls the endpoint, and writes both columns in one store batch.

**Tech Stack:** Node `http` server (server/app.ts), TypeScript, Vitest, React 18 + zustand sheet store, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-22-procore-sync-design.md`

## Global Constraints
- Read-only: only `GET` to the Procore API and `POST /oauth/token` to the login host. No other Procore writes.
- Never log or return the client secret or tokens. Logs carry event, project code and counts only.
- Env: `PROCORE_CLIENT_ID`, `PROCORE_CLIENT_SECRET`, `PROCORE_COMPANY_ID`, `PROCORE_ENV` (`sandbox` | `production`). Any missing or invalid → not configured → 503 "Procore is not set up on this server."
- Hosts: sandbox `https://login-sandbox.procore.com` / `https://sandbox.procore.com`; production `https://login.procore.com` / `https://api.procore.com`.
- Counted statuses (compare case-insensitively): work order contracts `Approved`, `Complete`; purchase order contracts `Approved`, `Partially Received`, `Received`, `Closed`.
- Cost codes match on line item `cost_code.code`, trimmed and upper-cased; requested codes upper-cased the same way.
- Column titles exactly `Committed (Procore)` (TEXT_NUMBER) and `Awarded` (PICKLIST, options `Yes`, `No`).
- Request limits: at most 5 projects, 50 cost codes in total. Per user: 1 sync in flight, 30 per hour.
- Don't run Prettier (no config in the repo); match the surrounding style by hand.
- Unit tests never call the real Procore: `fetch` is injected.

## Review Focus
- **Procore returns amounts as strings or null** ("1250000.50", null): sums must treat null as 0 and not concatenate strings. → Task 2 test `sums string and null amounts in cents`.
- **The same cost code typed in different case or with spaces on the sheet** (" chl "): must still match Procore's `CHL`. → Task 4 test `normalises cost codes from cells`.
- **A project cell that is not in "CODE — Name" form** (typed by hand, e.g. "BKK-03"): the code is the whole trimmed text. → Task 4 test `reads a bare project code`.
- **The sheet already has an `Awarded` column the user made** (e.g. a TEXT_NUMBER one): reuse it by title, don't add a second (title validation would refuse a duplicate anyway). → Task 4 test `reuses columns that already exist`.
- **The user leaves the sheet while a sync runs**: the request is aborted and nothing is written to the unmounted store. → Task 5 test `aborts on unmount`.

---

### Task 1: Procore client

**Files:**
- Create: `server/procore.ts`
- Test: `server/procore.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ProcoreConfig { clientId: string; clientSecret: string; companyId: string; loginHost: string; apiHost: string }
  export function procoreConfigFromEnv(env: Record<string, string | undefined>): { config: ProcoreConfig } | { missing: string[] }
  export class ProcoreError extends Error { constructor(message: string) }  // message is fit to show the user
  export interface ProcoreClient {
    readonly companyId: string
    /** Every item of a paginated list endpoint (array body), following Link rel="next". */
    getAll<T>(path: string, query: Record<string, string>, signal?: AbortSignal): Promise<T[]>
  }
  export interface ProcoreClientDeps { fetch?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void>; timeoutMs?: number }
  export function createProcoreClient(config: ProcoreConfig, deps?: ProcoreClientDeps): ProcoreClient
  ```

- [ ] **Step 1: Write failing tests** (fake `fetch` recording calls; `now` and `sleep` injected):
  - `reads config from env`: all four set with `PROCORE_ENV=sandbox` → sandbox hosts; `production` → production hosts; values trimmed; missing ones → `{ missing: ['PROCORE_CLIENT_SECRET', ...] }`; `PROCORE_ENV=staging` → missing includes `PROCORE_ENV`.
  - `signs in once and reuses the token`: two `getAll` calls → one `POST {loginHost}/oauth/token` with form body `grant_type=client_credentials&client_id=…&client_secret=…`; API calls carry `Authorization: Bearer t1` and `Procore-Company-Id: <companyId>`.
  - `signs in again when the token is about to expire`: `expires_in: 5400`; advance `now` by 5341 s → a second token request.
  - `retries once with a new token on 401`: API 401 then 200 → two token requests, result returned; 401 twice → `ProcoreError('Procore refused the app’s credentials.')`.
  - `follows pagination`: page 1 has `Link: <…page=2…>; rel="next"`, page 2 has none → items of both, requests carry `per_page=100` and `page=1`/`page=2`; more than 50 pages → `ProcoreError`.
  - `waits for the rate limit once`: 429 with `X-Rate-Limit-Reset` 3 s ahead → `sleep(3000)` then retry succeeds; reset 60 s ahead → `ProcoreError('Procore is busy; try again in a minute.')` without sleeping; 503 with `Retry-After: 2` treated the same.
  - `fails clearly`: a token request that answers 400/401 → `ProcoreError('Procore refused the app’s credentials.')`; network error or timeout → `ProcoreError('Could not reach Procore.')`; other non-2xx → `ProcoreError('Procore answered <status>.')`; a non-array body → `ProcoreError('Procore sent an unexpected response.')`.
  - `never puts the secret in an error message`: every thrown message above does not contain the secret.

- [ ] **Step 2: Run** `npx vitest run server/procore.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `server/procore.ts`.** Token kept until `now() >= obtainedAt + (expires_in - 60) * 1000`. Timeout via `AbortSignal.any([signal, AbortSignal.timeout(timeoutMs ?? 15000)])` where `signal` is given. Query built with `URLSearchParams` (brackets in `filters[...]` encode; fine). An aborted caller signal rethrows the AbortError as-is (not a ProcoreError).

- [ ] **Step 4: Run** the test file → PASS.

- [ ] **Step 5: Commit** `Procore sync: server client (sign-in, pagination, rate limits)`.

---

### Task 2: Committed totals

**Files:**
- Create: `server/procoreSync.ts`
- Modify: `src/planner/types.ts` (add the shared request/response types)
- Test: `server/procoreSync.test.ts`

**Interfaces:**
- Consumes: `ProcoreClient`, `ProcoreError` (Task 1).
- Produces (in `src/planner/types.ts`):
  ```ts
  export interface CommittedRequest { projects: { code: string; costCodes: string[] }[] }
  export interface CommittedCostCode { code: string; committed: number; awarded: boolean; known: boolean }
  export type CommittedProject =
    | { code: string; status: 'ok'; costCodes: CommittedCostCode[] }
    | { code: string; status: 'not-in-procore' | 'not-found' }
  export interface CommittedResponse { ok: true; projects: CommittedProject[] }
  ```
- Produces (in `server/procoreSync.ts`):
  ```ts
  export const MAX_PROJECTS = 5, MAX_COST_CODES = 50
  export function parseCommittedRequest(body: unknown): { ok: true; value: CommittedRequest } | { ok: false; error: string }
  export interface ProcoreLineItem { amount?: string | number | null; cost_code?: { code?: string | null } | null }
  export function sumByCostCode(lines: ProcoreLineItem[]): Map<string, number>   // code → cents
  export async function committedForProject(client: ProcoreClient, code: string, costCodes: string[], signal?: AbortSignal): Promise<CommittedProject>
  ```

- [ ] **Step 1: Write failing tests:**
  - `parses a valid request`: codes trimmed, cost codes trimmed + upper-cased + de-duplicated; `{ projects: [] }`, a non-object, a project without `code`, more than 5 projects, more than 50 cost codes in total, a cost code longer than 20 chars → `ok: false` with a message.
  - `sums string and null amounts in cents`: lines `{amount:'1250000.50', cost_code:{code:'chl'}}`, `{amount:100.25, cost_code:{code:'CHL '}}`, `{amount:null, cost_code:{code:'CHL'}}`, `{amount:'5', cost_code:null}` → `Map { 'CHL' => 125010075 }`.
  - `totals a project from counted commitments only` (fake client keyed by path):
    - projects `GET /rest/v1.1/projects` with query `company_id`, `filters[project_number]=BKK-03`, `filters[by_status]=All` → `[{ id: 7, project_number: 'BKK-03' }]`;
    - `/rest/v1.0/work_order_contracts` (`project_id=7`) → statuses `Approved` (id 1), `Draft` (id 2), `complete` (id 3), and `Approved` with `deleted_at` set (id 4);
    - `/rest/v1.0/purchase_order_contracts` → `Received` (id 5), `Submitted` (id 6);
    - line items of 1, 3, 5 carry CHL/GEN amounts; 2, 4, 6 must not be fetched;
    - `/rest/v1.0/cost_codes` (`project_id=7`) → `[{ code: 'CHL' }, { code: 'GEN' }, { code: 'TRF' }]`;
    - request `['CHL','GEN','TRF','ELE']` → `{ status:'ok', costCodes: [CHL sum true true, GEN sum true true, TRF 0 false true, ELE 0 false false] }`, amounts as numbers (cents / 100).
  - `matches the project number exactly`: projects returns `[{ project_number: 'BKK-03A' }]` → `{ status: 'not-found' }` and no commitment calls.
  - `passes ProcoreError through` from any call.

- [ ] **Step 2: Run** `npx vitest run server/procoreSync.test.ts` → FAIL.

- [ ] **Step 3: Implement.** Line items paths: `/rest/v1.0/work_order_contracts/{id}/line_items` and `/rest/v1.0/purchase_order_contracts/{id}/line_items`, query `project_id`. Cost codes path `/rest/v1.0/cost_codes`, query `project_id` (confirm the parameter in the downloaded spec `scratchpad/pc/rg.json`; if the list cannot be read, treat every requested code as `known: true` and log it). Fetch commitments' line items one at a time (rate limits). Parse amounts with `Math.round(Number(x) * 100)`; non-finite → 0.

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** `Procore sync: committed totals per cost code`.

---

### Task 3: Endpoint and wiring

**Files:**
- Modify: `server/app.ts` (dep, limiter, route), `server/main.ts` (env → client, doc comment)
- Test: `server/procoreRoute.test.ts` (same `start()` style as `server/app.test.ts`)

**Interfaces:**
- Consumes: Tasks 1–2; `AuthenticatedUser.history.options()` → `PlannerOptions.projects` (`code`, `inProcore`).
- Produces: `AppDeps.procore?: ProcoreClient | null`; `POST /api/procore/committed` → `CommittedResponse`.

- [ ] **Step 1: Write failing tests:**
  - `401 without a token`; `503 "Procore is not set up on this server."` when `procore` is null/absent.
  - `400` on an invalid body (message from `parseCommittedRequest`).
  - `syncs listed projects in Procore and skips the rest`: options projects `BKK-03 inProcore`, `VIL-01 !inProcore`; request BKK-03, VIL-01, ZZZ-9 → BKK-03 `ok` (fake client), VIL-01 and ZZZ-9 `not-in-procore`, and the fake client was called only for BKK-03.
  - `502 when Procore fails`: fake client throws `ProcoreError('Procore is busy; try again in a minute.')` → 502 `{ ok:false, error:'Could not sync with Procore: Procore is busy; try again in a minute.' }`.
  - `502 when options cannot be read` → `Could not read the project list.`
  - `limits syncs per user`: a second request while the first is pending → 429 `A Procore sync is already running for you.`; the 31st in an hour → 429 `You have reached the limit of 30 Procore syncs per hour. Try again later.` with `Retry-After`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** A second `createDraftLimiter({ perUserPerHour: 30, perUserInFlight: 1, globalInFlight: 4 })`; map its refusals to the messages above. Projects sequentially; abort on client disconnect like `importPlan`. Log `procore.sync` with `{ projects, synced }`. In `main.ts`: `procoreConfigFromEnv(env)`; on `missing`, log `config.warning` naming the missing variables (names only) unless all four are missing (then one line "Procore sync not configured."); pass `createProcoreClient(config)` or null. Add the four variables to the doc comment.
- [ ] **Step 4: Run** the new file and `npx vitest run server` → PASS.
- [ ] **Step 5: Commit** `Procore sync: POST /api/procore/committed`.

---

### Task 4: Collect and apply on the sheet

**Files:**
- Create: `src/planner/syncProcore.ts`
- Modify: `src/planner/plannerApi.ts` (`requestCommitted`)
- Test: `src/planner/syncProcore.test.ts`, `src/planner/plannerApi.test.ts`

**Interfaces:**
- Consumes: `CommittedRequest`, `CommittedResponse` (Task 2); `PROJECT_COLUMN_TITLE`, `COST_CODE_COLUMN_TITLE`, `DELIVERY_SITE_COLUMN_TITLE`, `BASIS_COLUMN_TITLE` (`sheetFromDraft.ts`); `SheetData`; `SheetState` (`addColumn`, `setCell`, `batch`).
- Produces:
  ```ts
  export const COMMITTED_COLUMN_TITLE = 'Committed (Procore)', AWARDED_COLUMN_TITLE = 'Awarded'
  export const OLD_PROJECT_COLUMN_TITLE = 'Procore project'
  export function canSyncProcore(data: SheetData): boolean
  export interface SyncGroup { project: string; costCode: string; rowIds: string[]; items: number }
  export interface SyncPlan { request: CommittedRequest; groups: SyncGroup[] }
  export function collectSync(data: SheetData): SyncPlan
  export interface SyncSummary { items: number; notFound: { project: string; costCode: string }[]; notInProcore: string[]; projectsNotFound: string[]; shared: { project: string; costCode: string; items: number }[] }
  export function applySync(state: SheetState, plan: SyncPlan, response: CommittedResponse): SyncSummary
  export function syncResultText(summary: SyncSummary, at: Date): string
  // plannerApi.ts
  export function requestCommitted(token: string, request: CommittedRequest, opts?: CallOptions): Promise<CommittedResponse>
  ```

- [ ] **Step 1: Write failing tests** (build SheetData by hand; for `applySync` use a real `createSheetStore` over the in-memory persistence the store tests use):
  - `canSyncProcore`: true with `Cost code` + `Project`, true with `Cost code` + `Procore project`, false without either.
  - `groups rows by project and cost code`: flat sheet, 3 rows `BKK-03 — Bangkok 3` / `CHL — Chiller`, one row without a cost code → one group `{ project:'BKK-03', costCode:'CHL', rowIds:[3 ids], items:1 }`, request `{ projects:[{ code:'BKK-03', costCodes:['CHL'] }] }`.
  - `counts summary rows as items`: multi-item sheet, two summary rows both `BKK-03`/`CHL` with children → `items: 2`; one summary `GEN` → `items: 1`.
  - `normalises cost codes from cells`: cell ` chl ` → `CHL`. `reads a bare project code`: `BKK-03` → `BKK-03`.
  - `adds the two columns after Delivery site, else before Basis` (two sheets); `reuses columns that already exist` (an existing `Awarded` column anywhere → no new column, values written into it).
  - `writes values only for synced projects`: response BKK-03 `ok` (CHL 1250000.5 awarded) + VIL-01 `not-in-procore` → BKK-03 rows get `1250000.5` and `Yes`; VIL-01 rows untouched; summary `{ items:1, notInProcore:['VIL-01'], ... }`; `known:false` codes go to `notFound`; `not-found` projects to `projectsNotFound`; groups with `items > 1` go to `shared`.
  - `syncResultText`: `Last synced 14:05 · 6 items updated · 1 cost code not found in Procore (ELE on BKK-03) · VIL-01 is not in Procore · BKK-02 was not found in Procore · CHL on BKK-03 is shared by 2 items; both show the cost code total`; singular forms (`1 item updated`); the time in 24-hour `HH:MM` local.
  - `requestCommitted` posts JSON to `/api/procore/committed` with the bearer token and rejects a body without `projects` array as `response`.
- [ ] **Step 2: Run** `npx vitest run src/planner/syncProcore.test.ts src/planner/plannerApi.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Codes from cells: text before ` — ` (or the whole text), trimmed; cost code upper-cased. A flat sheet = no row has children; then each group's `items` is 1; otherwise items = rows in the group that have children. `applySync` runs inside `state.batch`, adds a missing column with `addColumn(title, type, options, afterColId)` where `afterColId` is the Delivery site column, else the column before Basis, else the last column; write numbers with `String(n)`. In `plannerApi.ts`, make `call` take the path after `/api/` (`planner/options`, `procore/committed`, …) without changing any other behaviour.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `Procore sync: collect and write the sheet’s columns`.

---

### Task 5: The button

**Files:**
- Create: `src/planner/ProcoreSyncButton.tsx`
- Modify: `src/views/SheetView.tsx` (render in the tools beside Plan with AI), `src/views/sheetView.css`
- Test: `src/planner/ProcoreSyncButton.test.tsx`, `src/views/SheetView.test.tsx`

**Interfaces:**
- Consumes: Task 4; `getAccessToken(client)`; `useSheetStore`, `useSheetStoreApi`.
- Produces: `export function ProcoreSyncButton({ client }: { client: SupabaseClient }): JSX.Element | null`.

- [ ] **Step 1: Write failing tests** (mock `requestCommitted`):
  - SheetView: the button **Sync with Procore** shows for owner and editor on a sheet where `canSyncProcore`, not for a viewer, not on a sheet without a Cost code column.
  - `syncs and shows the result`: click → button reads `Syncing…` and is disabled; then cells written and a `role="status"` line with `Last synced …`.
  - `nothing to sync`: no row has both → status `Nothing to sync: no rows have both a project in Procore and a cost code.`; no request made. Also when every project came back `not-in-procore`, nothing is written and the status says which projects are not in Procore.
  - `shows errors and writes nothing`: rejected with `PlannerApiError('The planning server failed: Could not sync with Procore: Procore is busy; try again in a minute.', 'server')` → status `Could not sync: Procore is busy; try again in a minute.` (strip a leading `The planning server failed: ` and then `Could not sync with Procore: `); no column added.
  - `aborts on unmount`: unmount while pending → the request's signal is aborted and nothing is written.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Icon: reuse an existing icon name (`refresh` if `Icon` has it, else `sparkles`). Status line uses existing muted text styles; wraps on phones.
- [ ] **Step 4: Run** the two test files and `npx vitest run` (whole suite) → PASS; `npx tsc -b` clean.
- [ ] **Step 5: Commit** `Procore sync: Sync with Procore button`.

---

### Task 6: End to end

**Files:**
- Modify: `e2e/planner.spec.ts`

- [ ] **Step 1: Add** `test('Sync with Procore fills Committed and Awarded')`: stub options with a project `BKK-03` (`inProcore: true`) and cost codes, generate a one-item plan with project BKK-03 and cost code CHL (same flow as the existing Plan with AI tests), stub `**/api/procore/committed` with CHL `1250000` awarded, click **Sync with Procore**, expect columns `Committed (Procore)` and `Awarded` with `1250000` and `Yes`, and a status containing `Last synced`.
- [ ] **Step 2: Run** `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npm run test:e2e -- e2e/planner.spec.ts --trace off` → all pass.
- [ ] **Step 3: Commit** `Procore sync: e2e`.

---

## Not in this plan
- The migration adding `BKK-02` and the Properties project (`in_procore = true`): written as soon as the owner sends their number and name exactly as in Procore.
- The first real sandbox sync (owner sets the Railway variables).
