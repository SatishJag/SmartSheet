-- Baselines: named snapshots of a sheet's schedule (docs/superpowers/specs/2026-11-15-baselines-design.md).
-- Up to 5 per sheet (slots 1-5). A snapshot keeps each scheduled row's start, end and duration in
-- working days. baseline_rows.row_id deliberately has NO foreign key to rows: a baseline records
-- what the plan said then, so it must survive a later deletion of the row.
-- Same posture as 0002: owner-only row-level security, nothing for anon/public.

create table baselines (
  id uuid primary key default gen_random_uuid(),
  sheet_id uuid not null references sheets (id) on delete cascade,
  owner_id uuid not null default auth.uid(),
  workspace_id uuid not null default auth.uid(),
  slot smallint not null check (slot between 1 and 5),
  name text not null check (length(trim(name)) > 0 and length(name) <= 100),
  created_at timestamptz not null default now(),
  unique (sheet_id, slot),
  unique (id, sheet_id)
);

create table baseline_rows (
  baseline_id uuid not null,
  sheet_id uuid not null,
  owner_id uuid not null default auth.uid(),
  workspace_id uuid not null default auth.uid(),
  row_id uuid not null,
  start_date date not null,
  end_date date not null,
  -- Working days; 0 for a milestone.
  duration_days integer not null check (duration_days >= 0),
  primary key (baseline_id, row_id),
  check (end_date >= start_date),
  -- The rows belong to a baseline of the same sheet (the pattern of 0002's same-sheet keys).
  foreign key (baseline_id, sheet_id) references baselines (id, sheet_id) on delete cascade
);

create index baseline_rows_sheet_id_idx on baseline_rows (sheet_id);

alter table baselines enable row level security;
alter table baseline_rows enable row level security;

create policy baselines_owner on baselines
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and workspace_id = (select auth.uid())
    and exists (select 1 from sheets s where s.id = sheet_id and s.owner_id = (select auth.uid()))
  );

create policy baseline_rows_owner on baseline_rows
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and workspace_id = (select auth.uid())
    and exists (select 1 from sheets s where s.id = sheet_id and s.owner_id = (select auth.uid()))
  );

revoke all on baselines, baseline_rows from anon, public;
grant select, insert, update, delete on baselines, baseline_rows to authenticated;

-- Saves a baseline into a slot in one statement-level transaction: replaces whatever was in the slot
-- and stores `p_rows` ([{"rowId","start","end","durationDays"}, ...]) so a 5,000-row sheet is one
-- round trip. SECURITY INVOKER: the caller's row-level security applies to every read and write, so
-- another user's sheet is refused, never partially written.
create or replace function public.save_baseline(p_sheet_id uuid, p_slot integer, p_name text, p_rows jsonb)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id uuid;
begin
  delete from baselines where sheet_id = p_sheet_id and slot = p_slot;
  insert into baselines (sheet_id, slot, name) values (p_sheet_id, p_slot, p_name) returning id into v_id;
  insert into baseline_rows (baseline_id, sheet_id, row_id, start_date, end_date, duration_days)
    select v_id, p_sheet_id, (r ->> 'rowId')::uuid, (r ->> 'start')::date, (r ->> 'end')::date, (r ->> 'durationDays')::integer
    from jsonb_array_elements(p_rows) as r;
  return v_id;
end;
$$;

revoke all on function public.save_baseline(uuid, integer, text, jsonb) from public, anon;
grant execute on function public.save_baseline(uuid, integer, text, jsonb) to authenticated;
