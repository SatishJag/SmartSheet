-- Construction work-management MVP: core schema with row-level security.
-- Relies on Supabase's built-in auth.uid() and the `authenticated` role.

create table sheets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  workspace_id uuid not null default auth.uid(),
  name text not null,
  calendar jsonb not null default '{"workingWeekdays":[1,2,3,4,5],"nonWorkingDates":[],"hoursPerDay":8}'::jsonb,
  dependencies_enabled boolean not null default false,
  created_at timestamptz not null default now()
);

create table columns (
  id uuid primary key default gen_random_uuid(),
  sheet_id uuid not null references sheets (id) on delete cascade,
  owner_id uuid not null default auth.uid(),
  workspace_id uuid not null default auth.uid(),
  title text not null,
  type text not null check (type in (
    'TEXT_NUMBER', 'DATE', 'CHECKBOX', 'PICKLIST', 'MULTI_PICKLIST',
    'CONTACT_LIST', 'DURATION', 'PREDECESSOR'
  )),
  position integer not null,
  options jsonb,
  system_type text,
  role text check (role is null or role in (
    'start', 'end', 'duration', 'predecessor', 'percentComplete', 'status'
  )),
  width integer
);

create table rows (
  id uuid primary key default gen_random_uuid(),
  sheet_id uuid not null references sheets (id) on delete cascade,
  owner_id uuid not null default auth.uid(),
  workspace_id uuid not null default auth.uid(),
  parent_id uuid references rows (id) on delete cascade,
  position text not null,
  cells jsonb not null default '{}'::jsonb,
  version integer not null default 0
);

create table dependencies (
  id uuid primary key default gen_random_uuid(),
  sheet_id uuid not null references sheets (id) on delete cascade,
  owner_id uuid not null default auth.uid(),
  workspace_id uuid not null default auth.uid(),
  predecessor_row_id uuid not null references rows (id) on delete cascade,
  successor_row_id uuid not null references rows (id) on delete cascade,
  type text not null check (type in ('FS', 'SS', 'FF', 'SF')),
  lag_minutes integer not null default 0,
  check (predecessor_row_id <> successor_row_id)
);

create index columns_sheet_id_idx on columns (sheet_id);
create index rows_sheet_id_idx on rows (sheet_id);
create index rows_sheet_id_parent_id_idx on rows (sheet_id, parent_id);
create index dependencies_sheet_id_idx on dependencies (sheet_id);
create index dependencies_predecessor_row_id_idx on dependencies (predecessor_row_id);
create index dependencies_successor_row_id_idx on dependencies (successor_row_id);

alter table sheets enable row level security;
alter table columns enable row level security;
alter table rows enable row level security;
alter table dependencies enable row level security;

create policy sheets_owner on sheets
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- Child tables also require that the parent sheet belongs to the caller, so a
-- user cannot attach rows to someone else's sheet.
create policy columns_owner on columns
  for all to authenticated
  using (owner_id = auth.uid())
  with check (
    owner_id = auth.uid()
    and exists (select 1 from sheets s where s.id = sheet_id and s.owner_id = auth.uid())
  );

create policy rows_owner on rows
  for all to authenticated
  using (owner_id = auth.uid())
  with check (
    owner_id = auth.uid()
    and exists (select 1 from sheets s where s.id = sheet_id and s.owner_id = auth.uid())
  );

create policy dependencies_owner on dependencies
  for all to authenticated
  using (owner_id = auth.uid())
  with check (
    owner_id = auth.uid()
    and exists (select 1 from sheets s where s.id = sheet_id and s.owner_id = auth.uid())
  );

grant select, insert, update, delete on sheets, columns, rows, dependencies to authenticated;
