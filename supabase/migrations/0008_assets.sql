-- Smart assets: workspaces, folders, reports, dashboards and favourites
-- (docs/superpowers/specs/2026-11-16-smartsheet-feature-gap.md, section 5).
--
-- Vocabulary. `workspace_id` is the TENANT column every table carries (= auth.uid() until sharing exists).
-- The user-facing container is the table `workspaces`; other tables point at it with `space_id`.
--
-- Model.
--   workspaces            a named container owned by one user
--   folders               nested inside a workspace (at most 5 levels), moved only within their workspace
--   workspace_items       where one asset (a sheet, report or dashboard) lives: in a workspace, optionally
--                         inside a folder. An asset has AT MOST ONE placement; no placement = "not in a
--                         workspace" (the default). Deleting the asset deletes its placement.
--   reports, dashboards   the definitions. `definition` / `layout` are jsonb whose SHAPE is validated by the
--                         app (src/assets/definition.ts); the database only checks that it is an object of
--                         sane size. A report's source sheets are ids INSIDE the json (no foreign key): a
--                         deleted source sheet is reported by the app, it does not delete the report.
--   favorites             starred assets, workspaces and folders, per user
--
-- Same posture as 0002 and 0006: owner-only row-level security, nothing for anon / public, auth.uid() wrapped
-- in (select ...). Same-owner integrity is enforced by COMPOSITE foreign keys on (id, owner_id) instead of
-- extra policy subqueries: a foreign-key check ignores row-level security, so a plain key to someone else's
-- row would pass, but a key that must also match owner_id (always the caller, see the policies) cannot.

-- Needed by the composite keys below. (id is already unique, so this cannot fail on existing data.)
alter table sheets add constraint sheets_id_owner_id_key unique (id, owner_id);

create table workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  workspace_id uuid not null default auth.uid(),
  name text not null check (length(trim(name)) > 0 and length(name) <= 100),
  created_at timestamptz not null default now(),
  unique (id, owner_id)
);

create table folders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  workspace_id uuid not null default auth.uid(),
  space_id uuid not null,
  -- null = directly in the workspace
  parent_id uuid,
  name text not null check (length(trim(name)) > 0 and length(name) <= 100),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  unique (id, owner_id),
  -- the key the parent / item foreign keys point at: a child shares its workspace with its parent
  unique (id, space_id),
  check (parent_id is distinct from id),
  foreign key (space_id, owner_id) references workspaces (id, owner_id) on delete cascade,
  -- a null parent_id skips the check (MATCH SIMPLE), as in 0002
  foreign key (parent_id, space_id) references folders (id, space_id) on delete cascade
);

create table reports (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  workspace_id uuid not null default auth.uid(),
  name text not null check (length(trim(name)) > 0 and length(name) <= 100),
  -- { sources: [sheetId], columns, filter, sort, groupBy, summaries, gantt }; see src/assets/definition.ts
  definition jsonb not null default '{}'::jsonb
    check (jsonb_typeof(definition) = 'object' and octet_length(definition::text) <= 262144),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_id)
);

create table dashboards (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  workspace_id uuid not null default auth.uid(),
  name text not null check (length(trim(name)) > 0 and length(name) <= 100),
  -- { widgets: [{ id, type, x, y, w, h, title, config }] } on a 12-column grid; see src/assets/definition.ts
  layout jsonb not null default '{}'::jsonb
    check (jsonb_typeof(layout) = 'object' and octet_length(layout::text) <= 262144),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_id)
);

create table workspace_items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  workspace_id uuid not null default auth.uid(),
  space_id uuid not null,
  folder_id uuid,
  -- exactly one of the three asset columns is set
  sheet_id uuid,
  report_id uuid,
  dashboard_id uuid,
  asset_type text generated always as (
    case when sheet_id is not null then 'sheet' when report_id is not null then 'report' else 'dashboard' end
  ) stored,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  check (num_nonnulls(sheet_id, report_id, dashboard_id) = 1),
  -- one placement per asset
  unique (sheet_id),
  unique (report_id),
  unique (dashboard_id),
  foreign key (space_id, owner_id) references workspaces (id, owner_id) on delete cascade,
  foreign key (folder_id, space_id) references folders (id, space_id) on delete cascade,
  foreign key (sheet_id, owner_id) references sheets (id, owner_id) on delete cascade,
  foreign key (report_id, owner_id) references reports (id, owner_id) on delete cascade,
  foreign key (dashboard_id, owner_id) references dashboards (id, owner_id) on delete cascade
);

create table favorites (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  workspace_id uuid not null default auth.uid(),
  -- exactly one target
  sheet_id uuid,
  report_id uuid,
  dashboard_id uuid,
  space_id uuid,
  folder_id uuid,
  kind text generated always as (
    case
      when sheet_id is not null then 'sheet'
      when report_id is not null then 'report'
      when dashboard_id is not null then 'dashboard'
      when space_id is not null then 'workspace'
      else 'folder'
    end
  ) stored,
  created_at timestamptz not null default now(),
  check (num_nonnulls(sheet_id, report_id, dashboard_id, space_id, folder_id) = 1),
  unique (owner_id, sheet_id),
  unique (owner_id, report_id),
  unique (owner_id, dashboard_id),
  unique (owner_id, space_id),
  unique (owner_id, folder_id),
  foreign key (sheet_id, owner_id) references sheets (id, owner_id) on delete cascade,
  foreign key (report_id, owner_id) references reports (id, owner_id) on delete cascade,
  foreign key (dashboard_id, owner_id) references dashboards (id, owner_id) on delete cascade,
  foreign key (space_id, owner_id) references workspaces (id, owner_id) on delete cascade,
  foreign key (folder_id, owner_id) references folders (id, owner_id) on delete cascade
);

create index folders_space_id_idx on folders (space_id);
create index folders_parent_id_idx on folders (parent_id);
create index workspace_items_space_id_idx on workspace_items (space_id);
create index workspace_items_folder_id_idx on workspace_items (folder_id);
create index reports_owner_id_idx on reports (owner_id);
create index dashboards_owner_id_idx on dashboards (owner_id);
create index favorites_owner_id_idx on favorites (owner_id);

-- Folders nest at most 5 levels deep, and a folder cannot be moved into itself or one of its own
-- subfolders. The check counts the levels above the new parent and the levels below the folder.
create function public.folders_check_nesting()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_above integer := 0;
  v_below integer := 0;
  v_cycle boolean := false;
begin
  if new.parent_id is not null then
    with recursive up as (
      select id, parent_id, 1 as lvl from folders where id = new.parent_id
      union all
      select f.id, f.parent_id, up.lvl + 1 from folders f join up on f.id = up.parent_id where up.lvl < 50
    )
    select coalesce(max(lvl), 0), coalesce(bool_or(id = new.id), false)
      into v_above, v_cycle from up;
    if v_cycle then
      raise exception 'a folder cannot be moved into itself or one of its subfolders' using errcode = '23514';
    end if;
  end if;
  if tg_op = 'UPDATE' then
    with recursive down as (
      select id, 1 as lvl from folders where parent_id = new.id
      union all
      select f.id, down.lvl + 1 from folders f join down on f.parent_id = down.id where down.lvl < 50
    )
    select coalesce(max(lvl), 0) into v_below from down;
  else
    v_below := 0;
  end if;
  if v_above + 1 + v_below > 5 then
    raise exception 'folders can be nested at most 5 levels deep' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger folders_check_nesting
  before insert or update of parent_id on folders
  for each row execute function public.folders_check_nesting();

-- A folder stays in its workspace: moving it elsewhere would leave its children and items behind.
create function public.folders_keep_workspace()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.space_id is distinct from old.space_id then
    raise exception 'a folder cannot change workspace' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger folders_keep_workspace
  before update of space_id on folders
  for each row execute function public.folders_keep_workspace();

create function public.touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger reports_touch before update on reports for each row execute function public.touch_updated_at();
create trigger dashboards_touch before update on dashboards for each row execute function public.touch_updated_at();

alter table workspaces enable row level security;
alter table folders enable row level security;
alter table reports enable row level security;
alter table dashboards enable row level security;
alter table workspace_items enable row level security;
alter table favorites enable row level security;

create policy workspaces_owner on workspaces
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()) and workspace_id = (select auth.uid()));

create policy folders_owner on folders
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()) and workspace_id = (select auth.uid()));

create policy reports_owner on reports
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()) and workspace_id = (select auth.uid()));

create policy dashboards_owner on dashboards
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()) and workspace_id = (select auth.uid()));

create policy workspace_items_owner on workspace_items
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()) and workspace_id = (select auth.uid()));

create policy favorites_owner on favorites
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()) and workspace_id = (select auth.uid()));

revoke all on workspaces, folders, reports, dashboards, workspace_items, favorites from anon, public;
grant select, insert, update, delete on workspaces, folders, reports, dashboards, workspace_items, favorites to authenticated;

revoke all on function public.folders_check_nesting(), public.folders_keep_workspace(), public.touch_updated_at() from public, anon;
