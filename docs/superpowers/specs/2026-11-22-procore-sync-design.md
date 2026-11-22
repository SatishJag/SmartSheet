# Procore sync (committed cost per cost code): design

Date: 2026-11-22. Status: approaches and decisions agreed with the owner; awaiting approval of this text.

## Why
Plan with AI items carry a **project** and a **cost code** (specs 2026-11-21-cost-code-link,
2026-11-22-projects). The site team tracks whether each long-lead item has been awarded and for how much,
and that information lives in Procore's commitments (purchase orders and subcontracts). Today they look
it up by hand. A **Sync with Procore** button fills two columns on the plan sheet from Procore, so the
schedule shows what is committed next to when it is needed.

## Goals / non-goals / anti-goals
- Goals: on a Plan with AI sheet, an editor clicks **Sync with Procore** and each item's row shows
  **Committed (Procore)** (the total committed on its project + cost code) and **Awarded** (Yes/No), with
  a short result line saying what was updated and what was not found.
- Non-goals (MVP): PO-level detail or a PO picker, automatic/hourly sync, change orders, budget figures,
  syncing any sheet other than a Plan with AI sheet.
- Anti-goals: **any write to Procore**; Procore credentials in the browser, the repository or chat;
  overwriting columns the user did not ask to sync; a sync that half-fills a sheet and says it succeeded.

## Approaches
1. **Fetch live from Procore on each click (chosen).** The server signs in to Procore, reads the
   project's commitments and their line items, sums per cost code and returns the totals; the sheet writes
   them. Nothing new is stored; always current; smallest build.
2. Same, but store the totals in a table. Ready for an hourly sync later, but a new table to keep in
   step for a feature we are not building yet. Rejected for the MVP.
3. Read Procore's budget view (one call per project). The "committed" figure depends on how each budget
   view is configured, and the v1.0 endpoint is retired on 2027-09-30. Rejected.

## Decisions (owner)
- Read-only. Matching at **project + cost code** level only.
- Two columns: **Committed (Procore)** and **Awarded** (Yes/No). No PO picker.
- **Committed** = the sum of the line items carrying that cost code, across the project's commitments in
  a counted status, change orders excluded:
  - subcontracts (work order contracts): **Approved, Complete**;
  - purchase orders (their statuses differ): **Approved, Partially Received, Received, Closed**.
  - Draft, Out for bid, Out for signature, Processing, Submitted, Terminated and Void are not counted.
- **Awarded** = Yes when at least one counted commitment has a line on that cost code, else No.
- Cost codes match on Procore's **short code** (e.g. `CHL`), ignoring case. The real format is checked in
  the sandbox before relying on it.
- Two items on one sheet with the same project + cost code both show the same total, and the result
  says so ("CHL on BKK-03 is shared by 2 items; both show the cost code total.").
- The amount is each line's bottom-line `amount`.
- A manual **Sync with Procore** button on the sheet toolbar; it syncs that sheet only and shows
  "Last synced HH:MM" and the result. Editors and owners only; viewers see the values.
- Only Plan with AI sheets: a sheet with a **Cost code** column and a **Project** (or older
  **Procore project**) column. Only projects marked `in_procore`.
- The first sync adds the two columns after **Delivery site**, or before **Basis** when there is no
  Delivery site column.
- Projects synced for now: Data centre `BKK-02` and `BKK-03`, and one Properties project. BKK-02 and the
  Properties project are added by a migration once the owner sends their number and name exactly as in
  Procore.
- Credentials come from Railway environment variables; the owner creates a Procore app (Developer
  Sandbox first).

## Design

### Server: Procore client (`server/procore.ts`)
Configuration from the environment (documented in `server/main.ts`):

| Variable | Meaning |
|---|---|
| `PROCORE_CLIENT_ID`, `PROCORE_CLIENT_SECRET` | The Procore app's client credentials (DMSA / service account). |
| `PROCORE_COMPANY_ID` | The Procore company id (sent as `Procore-Company-Id`). |
| `PROCORE_ENV` | `sandbox` (Developer Sandbox) or `production`. |

Hosts by `PROCORE_ENV`: sandbox signs in at `https://login-sandbox.procore.com` and calls
`https://sandbox.procore.com`; production uses `https://login.procore.com` and `https://api.procore.com`.
If any variable is missing or `PROCORE_ENV` is neither value, the sync is **not configured**: the endpoint
answers 503 "Procore is not set up on this server." and the server logs one warning at start-up.

- **Sign-in:** `POST /oauth/token` with `grant_type=client_credentials`, client id and secret. The token
  is kept in memory until 60 seconds before its `expires_in` (read from each response, not assumed),
  then fetched again. A 401 from the API drops the token and retries once with a new one.
- **Requests:** `Authorization: Bearer …` and `Procore-Company-Id` on every call; a 15-second timeout per
  call; pagination by `page`/`per_page` following the `Link` header's `next` (or `Total`) until done.
- **Rate limits:** on 429, wait until `X-Rate-Limit-Reset` (or `Retry-After` on 503) if that is within
  10 seconds and retry once; otherwise fail the sync with "Procore is busy; try again in a minute."
- The secret and tokens are never logged or returned to the browser. Logs carry the event, the project
  code and counts only.
- `fetch` is injected, so tests run against a fake Procore and never call the real one.

### Server: committed totals (`server/procoreSync.ts`)
For each requested project code:
1. **Find the project:** `GET /rest/v1.1/projects?company_id=…&filters[project_number]=<code>` with
   `filters[by_status]=All`. No match: the project is reported as not found in Procore.
2. **List commitments:** `GET /rest/v1.0/work_order_contracts?project_id=…` and
   `GET /rest/v1.0/purchase_order_contracts?project_id=…`; keep the counted statuses above; skip deleted
   ones.
3. **Read line items** of each kept commitment
   (`…/work_order_contracts/{id}/line_items`, `…/purchase_order_contracts/{id}/line_items`) and add each
   line's `amount` to its `cost_code.code` (upper-cased). Lines with no cost code are ignored.
4. **Check the cost codes exist** on the project (`GET /rest/v1.0/cost_codes?project_id=…`), so a code
   with nothing committed can be told apart from a code Procore does not have.
5. Return, for each requested cost code: `committed` (a number, rounded to 2 decimals), `awarded`
   (boolean) and `known` (whether the project has that cost code in Procore).

The aggregation (steps 3 and 5) is a pure function over the fetched data, tested on its own. Amounts are
summed in integer cents to avoid floating-point drift.

### Server: endpoint
`POST /api/procore/committed` (signed-in users; JSON):

```json
{ "projects": [{ "code": "BKK-03", "costCodes": ["CHL", "GEN"] }] }
```

→ `200`:

```json
{ "projects": [
  { "code": "BKK-03", "status": "ok",
    "costCodes": [{ "code": "CHL", "committed": 1250000, "awarded": true, "known": true },
                  { "code": "GEN", "committed": 0, "awarded": false, "known": true }] },
  { "code": "VIL-01", "status": "not-in-procore" },
  { "code": "BKK-02", "status": "not-found" }
] }
```

- At most 5 projects and 50 cost codes per request; anything else is a 400.
- A project is synced only if the caller can read it in `projects` **and** it is `in_procore`
  (read with the caller's own Supabase client, so RLS applies); otherwise `not-in-procore`. This stops
  the endpoint being used to read arbitrary Procore projects.
- Limits: one sync in flight per user and 30 syncs per user per hour (a separate limiter from AI
  drafting, since no AI is called). Over the limit: 429 with `Retry-After`.
- A Procore failure for one project fails the whole request (502, with the reason), so the sheet is
  never half-updated.

### Sheet: the button and what it writes (`src/planner/procoreSync.ts` + `SheetView`)
- **Shown** on the sheet toolbar, next to **Plan with AI**, when the sheet has a **Cost code** column and
  a **Project** or **Procore project** column, and the viewer is the owner or an editor.
- **Collect:** every row with both a project and a cost code. The project code is the text before
  " — " in the project cell; the cost code is the text before " — " in the cost code cell. Rows are
  grouped by project + cost code.
- **Items, for the "shared" note:** on a sheet with summary rows (several items), an item is a summary
  row carrying a cost code; on a flat sheet (one item), the whole sheet is one item per project + cost
  code, so its activity rows sharing the code do not count as "shared".
- **Write:** in one store batch (one undo step, one save):
  - add **Committed (Procore)** (TEXT_NUMBER) and **Awarded** (PICKLIST: Yes, No) if the sheet does not
    have them, placed after Delivery site, else before Basis; columns already present (matched by title)
    are reused wherever they are;
  - on every row in a group whose project returned `ok`, set Committed to the number (plain digits, e.g.
    `1250000` or `1250000.5`, so formulas and sums work) and Awarded to Yes or No;
  - rows whose project was not synced are left as they are.
- **Result line** next to the button, e.g. "Last synced 14:05 · 6 items updated · 1 cost code not found
  in Procore (ELE on BKK-03) · VIL-01 is not in Procore". Shared cost codes get their note here too.
  While syncing, the button reads "Syncing…" and is disabled. Errors show in the same place
  ("Could not sync: Procore is busy; try again in a minute."). Nothing is written on an error.
- "Last synced" is the time of the sync made in this browser session; it is not stored (the values are).
- A sheet with no rows to sync says so ("Nothing to sync: no rows have both a project in Procore and a
  cost code.") and changes nothing.

### Database
- A migration adds `BKK-02` and the Properties project to `projects` with `in_procore = true` (and the
  right `project_type`), once the owner sends their number and name exactly as in Procore. The `code`
  must equal Procore's **project number**, since the sync looks projects up by it.
- No other schema change.

## Testing
- Unit: aggregation (statuses counted and not, case-insensitive codes, lines without a cost code,
  cents rounding, unknown codes); request parsing and limits; token caching, expiry and the 401 retry;
  pagination; 429 handling — all against an injected fake `fetch`.
- Endpoint: unauthenticated 401, not configured 503, a project not `in_procore` is skipped, a Procore
  failure gives 502 and no partial result.
- Sheet: the button shows only on qualifying sheets for owners and editors; columns are added in the
  right place once and reused after; values written on the right rows in one batch; the shared note on
  multi-item sheets and not on flat ones; nothing written on error.
- e2e: sync on a Plan with AI sheet against a stubbed `/api/procore/committed`, columns and values appear.
- Before going live: one manual sync against the owner's Developer Sandbox to confirm the cost code
  format and the statuses in real data.

## Calls left to the builder
- The exact `cost_codes` query parameters and fields (confirm in Procore's spec; the endpoint exists).
- Whether to read commitments with v1.0 (per type) or v2.0 `commitment_contracts`; v1.0 is the default
  because its line items carry `cost_code`.
- Wording of the result line, within the examples above.

## Risks
- The cost code format in the owner's Procore may differ from the codes in our table (e.g. a division
  prefix). Mitigated by matching the short code and checking the sandbox first.
- Procore's token lifetime may shorten (reports of 15 minutes); handled by reading `expires_in`.
- Large projects mean many line-item calls (one per commitment); fine for three projects, revisit with
  approach 2 if syncs become slow.
