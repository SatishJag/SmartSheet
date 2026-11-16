-- Resource management: resources (people, roles, equipment), their capacity calendar and time off,
-- and assignments of resources to tasks (docs/superpowers/specs/2026-11-16-resources-design.md).
--
-- * `resources` belong to the owner, not to a sheet: one person can work on many project sheets.
-- * Capacity is `hours_by_weekday` (7 numbers, 0 = Sunday ... 6 = Saturday); `resource_time_off` holds
--   date ranges with their own hours per day (0 = away, 4 = half days; where ranges overlap the app
--   takes the smallest figure).
-- * `assignments.row_id` deliberately has NO foreign key to rows (like baseline_rows.row_id): the
--   assignment history outlives a deleted task. An assignment whose row is gone carries no load.
-- * An assignment follows its task's dates unless it has its own start/end.
-- Same posture as 0002 / 0006: owner-only row-level security, nothing for anon/public, children
-- reference their parent with (id, owner_id) so they can never point at another user's rows.

create table resources (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  workspace_id uuid not null default auth.uid(),
  name text not null check (length(trim(name)) > 0 and length(name) <= 100),
  kind text not null default 'person' check (kind in ('person', 'role', 'equipment')),
  department text check (department is null or (length(trim(department)) > 0 and length(department) <= 100)),
  skills text[] not null default '{}' check (cardinality(skills) <= 30 and array_position(skills, null) is null),
  -- Money per hour, in the owner's currency (the app does not convert).
  cost_rate numeric(12, 2) not null default 0 check (cost_rate >= 0 and cost_rate <= 1000000),
  hours_by_weekday numeric(4, 2)[] not null default '{0,8,8,8,8,8,0}'
    check (
      array_length(hours_by_weekday, 1) = 7
      and array_position(hours_by_weekday, null) is null
      and 0 <= all (hours_by_weekday)
      and 24 >= all (hours_by_weekday)
    ),
  created_at timestamptz not null default now(),
  unique (id, owner_id)
);

create table resource_time_off (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null,
  owner_id uuid not null default auth.uid(),
  workspace_id uuid not null default auth.uid(),
  start_date date not null,
  end_date date not null,
  -- Capacity on those dates in hours per day; 0 = away.
  hours numeric(4, 2) not null default 0 check (hours >= 0 and hours <= 24),
  note text check (note is null or length(note) <= 200),
  created_at timestamptz not null default now(),
  check (end_date >= start_date and end_date - start_date <= 3660),
  foreign key (resource_id, owner_id) references resources (id, owner_id) on delete cascade
);

create table assignments (
  id uuid primary key default gen_random_uuid(),
  sheet_id uuid not null references sheets (id) on delete cascade,
  owner_id uuid not null default auth.uid(),
  workspace_id uuid not null default auth.uid(),
  -- No foreign key: see the header.
  row_id uuid not null,
  resource_id uuid not null,
  allocation_kind text not null check (allocation_kind in ('percent', 'hours_per_day', 'hours_per_week', 'total_hours')),
  allocation_value numeric(10, 2) not null check (allocation_value > 0),
  -- Own dates; null follows the task.
  start_date date,
  end_date date,
  created_at timestamptz not null default now(),
  check (start_date is null or end_date is null or end_date >= start_date),
  check (
    (allocation_kind = 'percent' and allocation_value <= 1000)
    or (allocation_kind = 'hours_per_day' and allocation_value <= 24)
    or (allocation_kind = 'hours_per_week' and allocation_value <= 168)
    or (allocation_kind = 'total_hours' and allocation_value <= 100000)
  ),
  unique (sheet_id, row_id, resource_id),
  foreign key (resource_id, owner_id) references resources (id, owner_id) on delete cascade
);

create index resources_owner_id_idx on resources (owner_id);
create index resource_time_off_resource_id_idx on resource_time_off (resource_id);
create index assignments_owner_id_idx on assignments (owner_id);
create index assignments_resource_id_idx on assignments (resource_id);
create index assignments_sheet_id_idx on assignments (sheet_id);

alter table resources enable row level security;
alter table resource_time_off enable row level security;
alter table assignments enable row level security;

create policy resources_owner on resources
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()) and workspace_id = (select auth.uid()));

create policy resource_time_off_owner on resource_time_off
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()) and workspace_id = (select auth.uid()));

create policy assignments_owner on assignments
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and workspace_id = (select auth.uid())
    and exists (select 1 from sheets s where s.id = sheet_id and s.owner_id = (select auth.uid()))
  );

revoke all on resources, resource_time_off, assignments from anon, public;
grant select, insert, update, delete on resources, resource_time_off, assignments to authenticated;
