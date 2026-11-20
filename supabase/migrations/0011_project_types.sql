-- Project types: the first choice in "Plan with AI" (Data centre, Properties, ...). Each schedule type
-- says which project types it applies to, so the wizard offers LLE procurement, and later other
-- kinds of schedule, under the project type the user picked.
--
-- Same shared reference library as 0004: any signed-in user reads it, nobody writes it through the
-- API (rows are loaded with the service role or the SQL editor).

create table project_types (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9-]*$'),
  name text not null,
  description text not null default '',
  position integer not null default 0
);

-- Postgres cannot reference into an array, so the ids are checked by the tests of the seed.
alter table schedule_types
  add column project_types text[] not null default '{}'
  check (array_position(project_types, null) is null);

alter table project_types enable row level security;

create policy project_types_read on project_types
  for select to authenticated using (true);

revoke all on project_types from anon, public;
grant select on project_types to authenticated;

insert into project_types (id, name, description, position) values
  ('data-centre', 'Data centre', 'Power, cooling and white-space fit-out for data halls.', 1),
  ('properties', 'Properties', 'Residential, commercial and mixed-use buildings.', 2);

-- Long-lead equipment (switchgear, transformers, chillers, lifts) is bought on both kinds of project.
update schedule_types set project_types = '{data-centre,properties}' where id = 'lle-procurement';
