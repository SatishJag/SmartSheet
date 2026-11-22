# Plan with AI inside Procore (side panel and full screen): design

Date: 2026-11-22. Status: decisions agreed with the owner; awaiting approval of this text.

## Why
Planners work in Procore. Opening a separate app to plan breaks their flow. The owner wants **Plan with AI
inside Procore**: a side panel next to the screen they are on, and a full-screen app for big plans (Data
centre All), opening on the project they are already in. The SmartSheet app keeps everything else
(sheets, schedules, punch lists…); the Procore pages carry Plan with AI only.

## Goals / non-goals / anti-goals
- Goals
  - One page, `/procore`, that shows only sign-in and Plan with AI, laid out for whatever width Procore
    gives it: a 400-pixel **side panel** or the **full screen** area.
  - The project is pre-selected from the Procore project the page was opened on.
  - After Create schedule, the planner can open the new sheet in the full app in a new browser tab.
  - Only Procore's own sites may show the page in a frame; every other address stays unframeable.
  - Written steps for the owner to register the app in Procore's Developer Portal and install it in the
    sandbox.
- Non-goals (this round): filling the cost code from the commitment the panel was opened on; Procore
  screens other than Schedule, Commitments and Budget; Procore single sign-on; showing sheets in Procore.
- Anti-goals: making the whole app frameable (click-jacking); a panel that fails silently when sign-in
  storage is blocked; trusting messages from any window other than Procore's.

## Decisions (owner)
- **Both** components: Side Panel and Full Screen, same page.
- Side panel on **Schedule, Commitments and Budget** screens.
- **Approach A:** a `/procore` address in the same app (not a separate bundle, not the whole app framed).
- Accepted proposals: sign in once inside Procore with the usual email and password; project pre-selected
  by project number with manual choice as fallback; one-column layout with the preview table scrolling
  inside its card; "Schedule created" with **Open in SmartSheet** (new tab); Import from Excel available;
  only Procore sites may frame the page; Safari fallback "Open in a new tab".

## Approaches
1. **`/procore` in the same app (chosen).** The entry already chooses a page by address (`/u/…`, `/a/…`);
   `/procore` gets a slim shell. The server allows framing only for that address.
2. A separate mini-app with its own build entry: smaller download, but a second build and duplicated
   sign-in. Rejected.
3. Let Procore frame the whole app: least work, but every page could be framed (click-jacking). Rejected.

## Design

### The page (`/procore`)
- `src/main.tsx` routes `/procore` (with or without trailing slash) to a new lazy-loaded
  `ProcorePanelPage` before `App` starts, like the public request pages.
- `ProcorePanelPage` = `AuthGate` (the existing email/password sign-in) + Plan with AI, with no app
  header, sheet list or tools.
- Plan with AI renders **as the page**, not as a modal dialog: no overlay, no close button, fills the
  frame. A prop on `PlannerWizard` (e.g. `embedded`) selects this; everything else (steps, preview, import,
  All, Sync-independent behaviour) is unchanged.
- Width: at ≤ 480 px the existing narrow (phone) layout applies; the preview's activity table scrolls
  sideways inside its card rather than squeezing columns. At full-screen widths it looks as today.
- **After Create schedule:** instead of opening the sheet (the app does that today), the page shows
  "Schedule created – <sheet name>" with **Open in SmartSheet** (opens `https://<our host>/?sheet=<id>` in
  a new tab, `rel="noopener"`) and **Plan another**, which returns to an empty request.

### Procore context
- **Full screen:** the External URL registered in Procore is
  `https://<our host>/procore?company={{procore.company.id}}&project={{procore.project.id}}`; the page reads
  both from the address.
- **Side panel:** the External URL is `https://<our host>/procore?view=panel`; on load, if
  `document.referrer` is one of Procore's origins, the page posts `{ type: 'initialize' }` to that origin and
  listens for the `setup` message, reading `context.company_id` and `context.project_id`. It also listens for
  `sidepanel:app:visible|hidden|destroy` (no behaviour needed beyond not erroring).
- **Trusted origins** (messages from any other origin are ignored; `targetOrigin` is always the exact
  origin): `https://app.procore.com`, `https://us02.procore.com`, `https://uk01.procore.com`,
  `https://sandbox.procore.com`, `https://login-sandbox.procore.com` — one list in code, shared with the
  server's frame rule.
- **Matching the project:** the page sends the Procore company and project ids to a new endpoint,
  `GET /api/procore/project?company=<id>&project=<id>` (signed-in users; uses the Procore client from the
  sync). The server reads the Procore project (`GET /rest/v1.0/projects/{id}?company_id=…`), takes its
  `project_number`, and answers with our project code if a project with that code is listed and readable
  by the caller (`{ code: 'BKK-03' }`), else `{ code: null, reason }`. Not configured → `{ code: null,
  reason: 'not-configured' }` (200, not an error: the page just leaves the project unchosen). The company
  id must equal `PROCORE_COMPANY_ID`; otherwise `{ code: null, reason: 'other-company' }`.
- The wizard gets the matched code as its initial project, and the project type that project belongs to
  (Data centre or Properties). The planner can still change both.

### Framing (server)
- `server/static.ts` sends `X-Frame-Options: DENY` and `frame-ancestors 'none'` on every page today. For
  the HTML served at `/procore` only, it instead sends
  `Content-Security-Policy: frame-ancestors <the trusted Procore origins>` and no `X-Frame-Options`
  (which cannot list several origins). Every other path, and all API responses, are unchanged.
- Assets (JS, CSS) need no frame headers; they are loaded by the framed page.

### Sign-in inside Procore
- The existing `AuthGate`; the session lives in the frame's own storage, so planners sign in once per
  browser inside Procore, separately from their normal SmartSheet tab.
- If the browser blocks storage in the frame (Safari, or strict privacy settings), the session cannot be
  kept: the page detects that storage is unavailable or the session does not survive a reload, and shows
  "Your browser blocks sign-in inside Procore. **Open Plan with AI in a new tab**", linking to the same
  `/procore?…` address (with company and project) at the top level.

### Registration steps for the owner (`docs/procore-app-setup.md`)
Developer Portal → app → Create Version → Components: add **Side Panel** (External URL with `view=panel`;
Supported Side Panel Views: the Schedule views, the commitments detail views, and the Budget views) and
**Full Screen** (External URL with the company and project parameters); save; install the version in the
Developer Sandbox; open a project's Schedule, a commitment and the Budget, and the Apps menu, to check.
The doc lists the exact view keys and URLs.

## Testing
- Unit: context parsing (address and `setup` message), origin allow-list (messages from other origins
  ignored; `initialize` only to a Procore referrer), the project-match endpoint (match, no match, other
  company, not configured, Procore failure → `{ code: null }`), frame headers per path (`/procore` vs `/`
  vs an API path vs an asset).
- Page: renders only sign-in, then Plan with AI without overlay or close; pre-selects the matched project;
  "Schedule created" with Open in SmartSheet; storage-blocked fallback.
- e2e: open `/procore?company=…&project=…` in a 400-px-wide viewport, sign in, plan, create; no sideways
  scroll of the page; a parent page on another origin cannot frame `/` (headers).

## Calls left to the builder
- Exact view keys listed in the setup doc (from Procore's Side Panel View Key Reference).
- How storage-blocking is detected.
- Wording of the "Schedule created" state, within the above.

## Risks
- Safari and strict browsers may not keep the session inside the frame; the new-tab fallback covers it.
- Project matching needs the Procore credentials and the project numbers to equal our codes; without them
  the planner chooses the project by hand.
- Procore may add regions; the origin list is in one place.
