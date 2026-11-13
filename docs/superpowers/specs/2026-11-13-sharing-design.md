# Sharing sheets: design (defaults chosen without a requirements conversation)

Date: 2026-11-13. Status: built; the product owner has not reviewed these defaults.

## What it does
A sheet's owner can share it, by email, with other existing users as **viewer** (read only) or **editor**
(edit cells, rows, columns and dependencies). Only the owner can rename, delete or share a sheet.
Shared sheets appear in the recipient's sheet list marked "Shared with you".

## Why this shape
- Smallest model that fits the existing schema: one `sheet_members` table, roles on the sheet, no teams.
- Enforced in the database (`supabase/migrations/0003_sharing.sql`), not just the UI. The UI follows it.
- Child rows (rows, columns, dependencies) keep `owner_id` = the SHEET owner, whoever edits them, so the
  existing client code that copies the owner onto new rows needs no change.

## Approaches considered
1. Per-sheet membership table with viewer/editor roles (chosen).
2. Workspaces with members: matches the reserved `workspace_id` column but needs workspace management UI,
   invites and a migration of every policy; far larger for no stated need.
3. Link sharing (anyone with the URL): needs anonymous access, which the schema deliberately forbids.

## Defaults and known limits (decide if these are wrong)
- The invitee must already have an account. `share_sheet()` tells the owner when an address has none, which
  lets an owner test whether an email is registered. No invite emails are sent.
- No ownership transfer, no "leave sheet" button yet (the policy already allows a member to delete their own row).
- Editors are not told in real time when a viewer role changes; a removed user's open tab fails to save.
- Concurrent edits stay last-write-wins per cell.
- Viewers are read-only in the grid, Gantt and Kanban via a store flag; the database also rejects their writes.
- Verified against PGlite and the in-browser fake, not a live Supabase project: apply `0003` to a staging project first.
