-- Resource management: people, projects, assignments (who works on what, when, and how much) and
-- saved views. Same ownership model as the sheet tables (0002_hardening.sql): every row belongs to
-- its owner, workspace_id must equal the owner until workspaces exist, and a row may only point at
-- the caller's own people, projects and sheets.

create table rm_people (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  workspace_id uuid not null default auth.uid(),
  first_name text not null,
  last_name text not null default '',
  email text,
  role text,
  discipline text,
  location text,
  tags jsonb not null default '[]'::jsonb check (jsonb_typeof(tags) = 'array'),
  -- Hours a full (100%) allocation means on one working day.
  capacity_hours_per_day numeric not null default 8 check (capacity_hours_per_day > 0 and capacity_hours_per_day <= 24),
  bill_rate numeric not null default 0 check (bill_rate >= 0),
  office_status text check (office_status is null or office_status in ('in_office', 'remote', 'out_of_office')),
  member_type text not null default 'employee' check (member_type in ('employee', 'contractor', 'placeholder')),
  is_approver boolean not null default false,
  created_at timestamptz not null default now(),
  unique (id, owner_id)
);

create table rm_projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  workspace_id uuid not null default auth.uid(),
  name text not null,
  client text,
  project_type text not null default 'confirmed' check (project_type in ('confirmed', 'tentative', 'internal')),
  state text not null default 'active' check (state in ('active', 'archived')),
  starts_at date not null,
  ends_at date not null,
  project_owner_id uuid,
  -- How the budget is tracked: an amount of money, a number of person-days, or not at all.
  budget_type text not null default 'none' check (budget_type in ('none', 'amount', 'days')),
  budget_amount numeric check (budget_amount is null or budget_amount >= 0),
  budget_days numeric check (budget_days is null or budget_days >= 0),
  tags jsonb not null default '[]'::jsonb check (jsonb_typeof(tags) = 'array'),
  sheet_id uuid references sheets (id) on delete set null,
  created_at timestamptz not null default now(),
  check (ends_at >= starts_at),
  unique (id, owner_id),
  -- The project owner must be one of the caller's own people; deleting the person clears it.
  foreign key (project_owner_id) references rm_people (id) on delete set null
);

create table rm_assignments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  workspace_id uuid not null default auth.uid(),
  project_id uuid not null,
  person_id uuid not null,
  starts_at date not null,
  ends_at date not null,
  -- Share of the person's daily capacity, in percent (over 100 means overtime).
  allocation_percent numeric not null default 100 check (allocation_percent > 0 and allocation_percent <= 200),
  status text not null default 'confirmed' check (status in ('confirmed', 'tentative')),
  notes text,
  created_at timestamptz not null default now(),
  check (ends_at >= starts_at),
  -- Composite keys tie the assignment to a project and a person of the SAME owner (FK checks
  -- bypass RLS, so this is what stops pointing at another user's rows).
  foreign key (project_id, owner_id) references rm_projects (id, owner_id) on delete cascade,
  foreign key (person_id, owner_id) references rm_people (id, owner_id) on delete cascade
);

create table rm_views (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  workspace_id uuid not null default auth.uid(),
  page text not null check (page in ('people', 'schedule', 'projects')),
  name text not null check (length(trim(name)) > 0),
  state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index rm_people_owner_idx on rm_people (owner_id);
create index rm_projects_owner_idx on rm_projects (owner_id);
create index rm_projects_sheet_idx on rm_projects (sheet_id);
create index rm_projects_project_owner_idx on rm_projects (project_owner_id);
create index rm_assignments_project_idx on rm_assignments (project_id);
create index rm_assignments_person_idx on rm_assignments (person_id);
create index rm_views_owner_page_idx on rm_views (owner_id, page);

alter table rm_people enable row level security;
alter table rm_projects enable row level security;
alter table rm_assignments enable row level security;
alter table rm_views enable row level security;

create policy rm_people_owner on rm_people
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()) and workspace_id = (select auth.uid()));

create policy rm_projects_owner on rm_projects
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and workspace_id = (select auth.uid())
    and (project_owner_id is null
      or exists (select 1 from rm_people p where p.id = project_owner_id and p.owner_id = (select auth.uid())))
    and (sheet_id is null
      or exists (select 1 from sheets s where s.id = sheet_id and s.owner_id = (select auth.uid())))
  );

create policy rm_assignments_owner on rm_assignments
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()) and workspace_id = (select auth.uid()));

create policy rm_views_owner on rm_views
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()) and workspace_id = (select auth.uid()));

revoke all on rm_people, rm_projects, rm_assignments, rm_views from anon, public;
grant select, insert, update, delete on rm_people, rm_projects, rm_assignments, rm_views to authenticated;
