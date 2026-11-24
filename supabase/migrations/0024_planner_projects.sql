-- Planner-added projects: any signed-in planner can add a project from the Plan with AI wizard.
--
-- Planners plan projects that do not exist yet (e.g. a data centre at feasibility stage), before they
-- are set up in Procore. The wizard's Project list now offers "+ New project…": a code and a name,
-- saved to this shared list. (docs/superpowers/specs/2026-11-23-new-project-design.md)
--
--   created_by  who added it; null for the projects seeded by migrations.
--   created_at  when it was added.
--
-- A planner adds a project only as themselves, not in Procore, not a programme and offered to the
-- planner. Nobody but the service role changes or deletes projects: Sync with Procore marks a planner
-- project as in Procore once Procore has a project with that number. The codes and names keep the
-- dropdown rules (no commas) and gain length limits.
--
-- Deploy note: the app works before and after this migration (without created_by it lists projects
-- without the "(new)" label), but "+ New project…" fails until it is applied.

alter table projects
  add column created_by uuid references auth.users (id) on delete set null,
  add column created_at timestamptz not null default now();

alter table projects
  add constraint projects_code_length check (length(code) <= 20),
  add constraint projects_name_length check (length(name) <= 80);

create policy projects_insert_own on projects
  for insert to authenticated
  with check (created_by = auth.uid() and in_procore = false and is_program = false and in_planner = true);

grant insert (code, name, project_type, created_by, in_procore, is_program, in_planner) on projects to authenticated;
