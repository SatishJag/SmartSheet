-- Projects for both businesses: one table for the projects a Plan with AI plan belongs to.
--
-- Plan with AI serves Data centre (long-lead equipment and its schedules) and Properties (villas,
-- towers, master communities, infrastructure). Every plan belongs to a project, so the wizard now
-- requires one, listed by the chosen project type. Cost codes stay optional.
-- (docs/superpowers/specs/2026-11-22-projects-design.md)
--
-- procore_projects (0020, 0021) becomes the general `projects` table; its rows, policy and grants carry
-- over with the rename.
--
--   project_type  the project type it belongs to (project_types, 0011); the wizard lists a type's
--                 projects only. Existing rows are data centre projects.
--   in_procore    the project exists in Procore. The Procore sync reads POs only for these. The property
--                 projects below are samples for the MVP, not in Procore; replace them with real ones
--                 (in a new migration) once they are set up.
--
-- Deploy note: the app reads `projects` from this version on. Old app code reading `procore_projects`
-- would lose the project list (planning still works), so apply this together with the deploy.

alter table procore_projects rename to projects;
alter policy procore_projects_read on projects rename to projects_read;
alter index procore_projects_pkey rename to projects_pkey;
alter table projects rename constraint procore_projects_code_check to projects_code_check;
alter table projects rename constraint procore_projects_name_check to projects_name_check;

alter table projects
  add column project_type text not null default 'data-centre' references project_types (id),
  add column in_procore boolean not null default true;

insert into projects (code, name, is_program, in_planner, project_type, in_procore) values
  ('VIL-01', 'Sample villa',            false, true, 'properties', false),
  ('TWR-01', 'Sample tower',            false, true, 'properties', false),
  ('MC-01',  'Sample master community', false, true, 'properties', false),
  ('INF-01', 'Sample infrastructure',   false, true, 'properties', false);
