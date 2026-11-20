# AI master planner: design (MVP)

Date: 2026-11-14

## Goal
A planner picks a schedule type (first: procurement of long-lead equipment, LLE), names the
equipment and the date it must be on site. The system drafts a first-cut schedule from historical
projects; the planner reviews, then approves it into an ordinary editable sheet.

## Split of responsibilities
- History database (Supabase): the activity catalog per schedule type, completed historical
  projects with actual activity durations, and duration statistics (p50, p80, min, max, n) per
  activity and equipment type. Seeded with clearly labelled SAMPLE data until real history is loaded.
- Planning server (Node, deployed on Railway): verifies the user's Supabase session, reads the
  catalog and statistics with the user's token (RLS applies), asks Claude to draft the plan through a
  single structured tool call, validates the result, and falls back to a deterministic history-only
  draft if the AI is unavailable or returns something invalid. Holds the Anthropic API key; the
  browser never sees it. Also serves the built SPA.
- Client: the "Plan with AI" wizard; backward planning (latest start so the target activity
  finishes on the required date) with the existing engine; a preview with dates, durations and
  their basis, rationale, risks and feasibility ("must start by", "already N working days late");
  Approve creates a normal sheet the planner then edits.

## Rules
- Durations come from history, not invented: every AI duration must cite p50/p80/default or be
  marked 'adjusted' with a reason. Server rejects activity codes outside the catalog, cycles,
  non-positive durations, links to unknown codes, and more than one target.
- Dates are never produced by the AI; the engine computes them.
- The contract is `src/planner/types.ts`.

## Out of scope (MVP)
Uploading real history (P6/Excel import), learning from approved plans, multi-equipment packages,
resource levelling.
