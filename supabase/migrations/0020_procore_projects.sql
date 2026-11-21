-- Procore projects: which Procore project a Plan with AI plan is bought against.
--
-- In Procore a budget line is project + cost code (0019_cost_codes.sql): "CHL" alone does not say
-- whose budget it spends. Data centre long-lead equipment is bought at program level: a program
-- (dummy) project owns the budget and the batch POs, and the equipment is later delivered to the real
-- sites. A plan is bought against one project, chosen once at the top of the wizard.
-- (docs/superpowers/specs/2026-11-21-cost-code-link-design.md, "Addendum: Procore project on the plan")
--
--   code        exactly as in Procore (the project number), e.g. 'BKK-03'
--   name        exactly as in Procore, e.g. 'Bangkok 3'. No commas: the generated sheet offers
--               "CODE — Name" as dropdown options.
--   is_program  a program (dummy) project; listed before the site projects
--   in_planner  only these projects are offered in the wizard and in the sheet's column
--
-- Only real Procore projects are listed. The program project does not exist in Procore yet; when it
-- does, add it in a new migration with is_program = true.
--
-- Same shared reference library as 0004 / 0019: any signed-in user reads it, nobody writes it through
-- the API.

create table procore_projects (
  code text primary key check (code ~ '^[A-Z0-9][A-Z0-9-]*$'),
  name text not null check (length(trim(name)) > 0 and position(',' in name) = 0),
  is_program boolean not null default false,
  in_planner boolean not null default true
);

alter table procore_projects enable row level security;

create policy procore_projects_read on procore_projects
  for select to authenticated using (true);

revoke all on procore_projects from anon, authenticated, public;
grant select on procore_projects to authenticated;

insert into procore_projects (code, name, is_program, in_planner) values
  ('BKK-03', 'Bangkok 3', false, true);
