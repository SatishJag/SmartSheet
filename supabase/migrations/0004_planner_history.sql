-- AI master planner: the history library (docs/superpowers/specs/2026-11-14-ai-master-planner-design.md).
-- The TypeScript contract is src/planner/types.ts; src/planner/history.ts reads these objects.
--
--   schedule_types       kinds of schedule the planner can draft (e.g. 'lle-procurement')
--   activity_catalog     the standard activities of each type, their usual logic and fallback durations
--   history_projects     completed historical projects (one per equipment item)
--   history_activities   the actual duration of each catalog activity on a historical project
--
-- This is a SHARED REFERENCE LIBRARY, not per-user data: every signed-in user may read all of it,
-- and nobody writes it through the API. Rows are loaded with the service role or the SQL editor
-- (both bypass RLS). Sample rows (is_sample = true, seeded by 0005) are removed with
--   delete from history_projects where is_sample;
-- once the company's own history is loaded.

-- 1. Tables -------------------------------------------------------------------------------
create table schedule_types (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9-]*$'),
  name text not null,
  description text not null default ''
);

create table activity_catalog (
  schedule_type text not null references schedule_types (id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9_]+$'),
  name text not null,
  phase text not null,
  sequence integer not null check (sequence > 0),
  -- The usual predecessors: [{"from": "<code>", "type": "FS"|"SS"|"FF"|"SF", "lagDays": <int>}].
  -- Codes are checked by the tests of the seed; Postgres cannot reference into JSON.
  default_links jsonb not null default '[]'::jsonb check (jsonb_typeof(default_links) = 'array'),
  -- Working days used when history has no data for the activity (0 only for milestones).
  default_days integer not null check (default_days >= 0),
  -- The activity whose finish is the date the planner asks for (e.g. 'On site').
  is_target boolean not null default false,
  primary key (schedule_type, code),
  unique (schedule_type, sequence)
);

-- At most one target per schedule type.
create unique index activity_catalog_one_target on activity_catalog (schedule_type) where is_target;

create table history_projects (
  id uuid primary key default gen_random_uuid(),
  schedule_type text not null references schedule_types (id) on delete cascade,
  -- The grouping key for statistics, e.g. 'Power transformer'; matches PlanRequest.equipmentType.
  equipment_type text not null check (length(trim(equipment_type)) > 0),
  equipment_name text not null,
  region text,
  vendor text,
  po_date date,
  required_on_site date,
  actual_on_site date,
  notes text,
  -- True for seed sample data; the planner tells the user when statistics rest only on samples.
  is_sample boolean not null default false,
  created_at timestamptz not null default now(),
  unique (id, schedule_type)
);

create index history_projects_type_equipment on history_projects (schedule_type, equipment_type);

-- schedule_type is repeated here so that two composite foreign keys can guarantee that the code is
-- in the catalog of the project's own schedule type (the pattern of 0002's same-sheet keys).
create table history_activities (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  schedule_type text not null,
  code text not null,
  -- Working days the activity actually took.
  actual_days integer not null check (actual_days > 0),
  -- Working days it was planned to take, when known.
  planned_days integer check (planned_days is null or planned_days >= 0),
  unique (project_id, code),
  foreign key (project_id, schedule_type)
    references history_projects (id, schedule_type) on delete cascade on update cascade,
  foreign key (schedule_type, code)
    references activity_catalog (schedule_type, code) on update cascade
);

create index history_activities_type_code on history_activities (schedule_type, code);

-- Distinct equipment types with history, per schedule type (what the wizard offers). A view so the
-- client does not page through every project. security_invoker: the caller's RLS applies.
create view planner_equipment_types with (security_invoker = true) as
  select distinct schedule_type, equipment_type from history_projects;

-- 2. Row-level security and privileges: read-only for signed-in users, nothing for anon ---------
alter table schedule_types enable row level security;
alter table activity_catalog enable row level security;
alter table history_projects enable row level security;
alter table history_activities enable row level security;

create policy schedule_types_read on schedule_types for select to authenticated using (true);
create policy activity_catalog_read on activity_catalog for select to authenticated using (true);
create policy history_projects_read on history_projects for select to authenticated using (true);
create policy history_activities_read on history_activities for select to authenticated using (true);

-- Supabase's default privileges grant ALL on new tables to anon and authenticated. Take them back:
-- with no write policies RLS would already refuse writes, but without the privilege they fail
-- loudly (permission denied) instead of silently affecting 0 rows. The service role is untouched.
revoke all on schedule_types, activity_catalog, history_projects, history_activities, planner_equipment_types
  from anon, authenticated, public;
grant select on schedule_types, activity_catalog, history_projects, history_activities, planner_equipment_types
  to authenticated;

-- 3. Statistics ---------------------------------------------------------------------------
-- Duration statistics per activity (HistorySummary in src/planner/types.ts), over every equipment
-- type of the schedule type or, given p_equipment_type, over that one. Working days. p50 and p80
-- are percentile_cont (linear interpolation) rounded UP to whole days; rounding to 6 decimals first
-- keeps floating-point noise (e.g. 15.000000000000002) from adding a day. Stats are ordered by the
-- catalog sequence. sampleOnly is true when there is at least one project and all are samples.
--
-- SECURITY INVOKER: runs with the caller's privileges, so the policies above apply.
create or replace function public.planner_history_summary(p_schedule_type text, p_equipment_type text default null)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with projects as (
    select p.id, p.is_sample
    from history_projects p
    where p.schedule_type = p_schedule_type
      and (p_equipment_type is null or p.equipment_type = p_equipment_type)
  ),
  stats as (
    select
      a.code,
      count(*)::int as n,
      ceil(round((percentile_cont(0.5) within group (order by a.actual_days))::numeric, 6))::int as p50,
      ceil(round((percentile_cont(0.8) within group (order by a.actual_days))::numeric, 6))::int as p80,
      min(a.actual_days) as min,
      max(a.actual_days) as max
    from history_activities a
    join projects p on p.id = a.project_id
    group by a.code
  )
  select jsonb_build_object(
    'scheduleType', p_schedule_type,
    'equipmentType', p_equipment_type,
    'projectCount', (select count(*)::int from projects),
    'sampleOnly', coalesce((select bool_and(is_sample) from projects), false),
    'stats', coalesce(
      (select jsonb_agg(
                jsonb_build_object('code', s.code, 'n', s.n, 'p50', s.p50, 'p80', s.p80, 'min', s.min, 'max', s.max)
                order by c.sequence, s.code)
         from stats s
         left join activity_catalog c on c.schedule_type = p_schedule_type and c.code = s.code),
      '[]'::jsonb)
  );
$$;

-- Functions are executable by PUBLIC by default; only signed-in users may call this one.
revoke all on function public.planner_history_summary(text, text) from public, anon;
grant execute on function public.planner_history_summary(text, text) to authenticated;
