-- The data centre program project, now created in Procore.
--
-- Data centre long-lead equipment is bought at program level: this program (dummy) project owns the
-- budget and the batch POs, and the equipment is later delivered to the real sites (BKK-03, ...).
-- is_program puts it first in the Plan with AI "Procore project" dropdown (0020_procore_projects.sql).
-- Code and name exactly as in Procore.

insert into procore_projects (code, name, is_program, in_planner) values
  ('PRG-DC-01', 'Data centre programme', true, true);
