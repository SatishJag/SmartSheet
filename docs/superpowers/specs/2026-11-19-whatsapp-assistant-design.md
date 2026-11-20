# WhatsApp assistant — design

Status: built (2026-11-19). Replaces the WBS9 WhatsApp bot (separate repository
`wbs9-whatsapp-bot`, Python, Smartsheet / Monday.com) with the same capabilities built into this
planner, for every company that uses it.

## Intent

Site teams live in WhatsApp, not in a browser. The WBS9 bot proved that delay alerts, a numbered menu
("1 = delayed tasks"), one-line status replies ("3 Done") and plain-language questions over the
schedule get used on site. That bot was single-tenant: four hard-coded Smartsheet sheets, a list of
phone numbers in an environment variable, state in JSON files and memory, no webhook signature check,
an open dashboard API. This design brings the capabilities into the planner as a product feature that
any account can turn on, with the planner's own data, access rules and server.

## Goals

- Everything the WBS9 bot did that matters on site, against planner sheets:
  - Alerts: a task slips past its finish (delay alert), progress nudges at 50 / 70 / 90 % of a task's
    planned duration with reminders and a "no response" report, a daily summary, all with
    do-not-disturb hours. Critical-path tasks (total float 0) are HIGH priority and ignore DND.
  - The menu: pick a project, then 1 Delayed, 2 Due in 30 days, 3 On track / at risk, 4 Critical path,
    5 Milestones, 6 Send delay reminders to task owners, 7 Summary, 0 Switch project.
  - Replies that update the sheet: `N <status> [- comment]` against the last numbered list, `#N` for a
    task's detail, quick answers to a nudge (`1` On track, `2` Delayed, `3` Done, `4` Blocked).
  - Plain-language questions answered by Claude from the sheet's data only, with the menu as fallback.
  - STOP / START, EMAIL (full list to the user's account e-mail).
- Multi-tenant and safe: a phone only ever sees sheets its owner may see; everything is per account.
- Works without any WhatsApp credentials (simulator), so it can be built, tested and demoed.

## Non-goals (this round)

- Server-rendered chart images (the WBS9 bot's matplotlib charts); the planner has dashboards.
- Writing "revised" dates back into user columns; forecasts are shown, not written.
- A separate mobile app (the WBS9 Expo app); the planner web app is responsive.
- Per-company WhatsApp sender numbers; one platform number serves every account.
- Voice notes.

## Anti-goals

- Messaging a phone that did not opt in. Every phone on the platform has proven ownership by sending
  us a message first (link code or join code), and STOP is honoured globally.
- A WhatsApp number that can read or change another account's sheets.

## Who is on WhatsApp

1. **Planner users.** In the app (WhatsApp section) a signed-in user asks for a link code. The app shows a `wa.me` link with `LINK <code>` prefilled; sending it from the phone binds the
   phone to the account. Proof of ownership, opt-in and the opening of WhatsApp's 24-hour service
   window happen in one step, and no message template is needed. Linked users get the menu over the
   sheets they own and the sheets shared with them, alerts and summaries for their own sheets, and
   may update tasks where they are owner or editor.
2. **Site contacts (no planner account)** — subcontractors, foremen. The sheet owner adds a contact
   (name, the e-mail used in the sheet's Contact columns, phone). The app gives a join link
   (`JOIN <code>`) the owner forwards; when the contact sends it the contact becomes active. An active
   contact receives delay alerts and nudges for tasks where their e-mail is in the task-owner column,
   and can list and update only those tasks, in that owner's sheets. Nothing else.

Access follows sheet sharing (0017_sharing), through `roleOf` / `canTouch` in
`server/whatsapp/conversation.ts`:

| Who | Menu, lists, details, questions | Update tasks | Send delay reminders (6) | Alerts and summary settings |
| --- | --- | --- | --- | --- |
| Owner | yes | yes | yes | yes (WhatsApp page) |
| Editor | yes | yes | yes | no (owner's) |
| Viewer | yes | only tasks whose owner column holds their e-mail | no | no |
| Site contact | their own tasks | their own tasks | no | no |

Removing someone from a sheet takes effect on their next message: the sheet leaves their picker and
lists from it no longer open. Messages to an editor or viewer count against their own account's
daily cap; a non-owner's update is reported to the owner in the app.

## Columns

Found by role, never by title, where the planner has a role: start, end, duration, % complete,
status. The task-owner column is chosen in the sheet's WhatsApp settings; when unset, the first
Contact column whose title matches owner / responsible / assigned, else the first Contact column.
Department and comments columns are matched by title (as the WBS9 bot did). Status replies are
matched against the status column's picklist options (case-insensitive, prefix, plus synonyms such
as done = Complete); "done" also sets % complete to 100 when that column exists.

## Task facts (shared pure code, `src/whatsapp/`)

Computed on the server with the planner's own engine (`schedule()` + `analyzeCriticalPath()`), so
float is the same number the Gantt shows. Per leaf row: planned start / finish (scheduled values when
the sheet schedules, else the cells), complete (status is a done value or % complete = 100), delay
days, days to finish, total float, priority (float 0 = HIGH, 1..14 = MEDIUM, else LOW; no float when
dependencies are off: MEDIUM), owner e-mails, status, and the WBS9 forecast (revised finish =
start + duration x (1 + remaining share)).

## Delivery

- Provider: Meta WhatsApp Cloud API (`/messages`), or a simulator when not configured (messages are
  stored as `simulated` and shown in the app's WhatsApp activity and test chat).
- Outbox table `whatsapp_messages`: every inbound and outbound message, with status, attempts and a
  next-attempt time (retry with backoff, 3 attempts), a daily cap per account, DND deferral for
  non-HIGH priority, and a unique dedup key so an alert is sent once per task and date.
- WhatsApp only allows free text within 24 hours of the person's last message. Outside it, if
  `WHATSAPP_TEMPLATE_NAME` is configured the message goes as that template (one body parameter: the
  message flattened to one line, ending "Reply MENU for details"); without a template it is skipped
  and recorded as such.
- Rules: the existing Automation "Notify" action gets "Also send on WhatsApp": each recipient e-mail
  (and the owner) becomes a `notifications` row with channel `whatsapp`; the server resolves the
  e-mail to a linked user or active contact of that owner, and records it skipped otherwise.

## Inbound

`GET /api/whatsapp/webhook` answers Meta's verify challenge; `POST` checks `X-Hub-Signature-256`
(HMAC-SHA256 with the app secret) before reading anything, deduplicates by provider message id, and
answers 200 quickly; replies are sent through the outbox. Per-phone rate limit. Unknown phones get one
short "not linked" answer per day.

Conversation state (selected sheet, last numbered list, pending nudge) lives in
`whatsapp_sessions`, not memory, so restarts and several instances are safe.

## AI

Claude through the server's existing Anthropic client (`ANTHROPIC_API_KEY`), the WBS9 system prompt
adapted (answer only from the data, `SHOW_MENU` when unsure, WhatsApp formatting, max 15 tasks). The
context is a compact summary of the selected sheet's task facts. Per-phone hourly limit, 30 s timeout;
without a key, free text shows the menu.

## Settings (per sheet, owner only)

WhatsApp on/off, delay alerts, progress nudges (reminder interval hours, max reminders), daily summary
hour and time zone, DND start / end, task-owner column.

## Data (migration 0015_whatsapp.sql)

`whatsapp_links` (user ↔ phone), `whatsapp_contacts` (owner's site contacts), `whatsapp_codes`
(link / join codes, hashed), `whatsapp_sheet_settings`, `whatsapp_sessions`, `whatsapp_messages`,
`whatsapp_nudges`, `whatsapp_optouts`; `notifications.channel` gains `whatsapp`. Users read their own
link, settings, contacts and message log; everything the server decides (sessions, codes, opt-outs,
delivery columns) is service-role only.

## Configuration (server only)

`WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`,
`WHATSAPP_BUSINESS_NUMBER` (shown in wa.me links), optional `WHATSAPP_TEMPLATE_NAME`,
`WHATSAPP_TEMPLATE_LANG` (default `en`), `WHATSAPP_MESSAGES_PER_DAY` (per account, default 300).
Requires `SUPABASE_SERVICE_ROLE_KEY` like the rest of server automation.

## Approaches considered

1. **Keep the Python bot, swap its data source to Supabase.** Least new code, but a second service
   with its own state, no reuse of the planner's scheduling engine (float would differ from the
   Gantt), and its single-tenant shape (numbers in env vars, memory state) would have to be rebuilt
   anyway.
2. **Supabase Edge Functions.** No extra service, but the planner already runs a Node server with the
   service-role store, scheduler, outbox, rate limits and the Anthropic client.
3. **A channel inside the planner's server (chosen).** Reuses the store, scheduler, outbound policy,
   the scheduling engine and the AI client; one deployment; tests run with the existing fakes.

## Left to the builder

Exact wording of messages, page layout (follows the Automation page), retry timings.
