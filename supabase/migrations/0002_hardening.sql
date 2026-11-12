-- Hardening for the MVP schema (0001_schema.sql):
--   1. No table privileges for anon / public (RLS already hid every row; this is defense in depth).
--   2. Same-sheet integrity: a row's parent and a dependency's two endpoints must be rows of the
--      SAME sheet (and therefore never another user's rows; FK checks bypass RLS, so this matters).
--   3. One dependency per (predecessor, successor) pair, as the app enforces, so a diff-based
--      dependency save can upsert on the pair and a failed delete never leaves duplicates.
--   4. Policies: workspace_id must equal the caller until workspaces exist, and auth.uid() is
--      wrapped in (select ...) so Postgres evaluates it once per statement, not once per row.

-- 1. Privileges ---------------------------------------------------------------------------
revoke all on sheets, columns, rows, dependencies from anon, public;
-- (0001's `grant select, insert, update, delete ... to authenticated` stays.)

-- 2. Same-sheet integrity -----------------------------------------------------------------
alter table rows add constraint rows_id_sheet_id_key unique (id, sheet_id);

-- A null parent_id skips the composite check (MATCH SIMPLE): top-level rows are fine.
alter table rows drop constraint rows_parent_id_fkey;
alter table rows
  add constraint rows_parent_same_sheet_fkey
  foreign key (parent_id, sheet_id) references rows (id, sheet_id) on delete cascade;

alter table dependencies drop constraint dependencies_predecessor_row_id_fkey;
alter table dependencies drop constraint dependencies_successor_row_id_fkey;
alter table dependencies
  add constraint dependencies_predecessor_same_sheet_fkey
  foreign key (predecessor_row_id, sheet_id) references rows (id, sheet_id) on delete cascade;
alter table dependencies
  add constraint dependencies_successor_same_sheet_fkey
  foreign key (successor_row_id, sheet_id) references rows (id, sheet_id) on delete cascade;

-- 3. One dependency per pair --------------------------------------------------------------
-- Drop any duplicates an older client may have written (keep one per pair) before adding the key.
delete from dependencies d
  using dependencies e
  where d.sheet_id = e.sheet_id
    and d.predecessor_row_id = e.predecessor_row_id
    and d.successor_row_id = e.successor_row_id
    and d.id > e.id;
alter table dependencies
  add constraint dependencies_pair_key unique (sheet_id, predecessor_row_id, successor_row_id);

-- 4. Policies (same names and semantics as 0001, plus the workspace check) ----------------
drop policy sheets_owner on sheets;
drop policy columns_owner on columns;
drop policy rows_owner on rows;
drop policy dependencies_owner on dependencies;

create policy sheets_owner on sheets
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()) and workspace_id = (select auth.uid()));

-- Child tables also require that the parent sheet belongs to the caller, so a
-- user cannot attach rows to someone else's sheet.
create policy columns_owner on columns
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and workspace_id = (select auth.uid())
    and exists (select 1 from sheets s where s.id = sheet_id and s.owner_id = (select auth.uid()))
  );

create policy rows_owner on rows
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and workspace_id = (select auth.uid())
    and exists (select 1 from sheets s where s.id = sheet_id and s.owner_id = (select auth.uid()))
  );

create policy dependencies_owner on dependencies
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and workspace_id = (select auth.uid())
    and exists (select 1 from sheets s where s.id = sheet_id and s.owner_id = (select auth.uid()))
  );
