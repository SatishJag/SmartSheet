-- Procore cost codes: the link between a Plan with AI item and the money in Procore.
--
-- A long-lead plan starts at specification and tender, before any PO exists, but the Procore budget
-- (with these cost codes) already does. So the cost code is what an item is tagged with; the
-- commitment / PO comes later and is out of scope for now (docs/superpowers/specs/2026-11-21-cost-code-link-design.md).
--
--   code            exactly as in Procore (Project Settings > Work Breakdown Structure > Cost Code)
--   description     exactly as in Procore, typos included ("Colling Tower", "HV SiwtchGear"): the code
--                   is what a later sync matches on, and spelling fixes belong in Procore. No commas,
--                   because the generated sheet offers "CODE — Description" as dropdown options.
--   in_planner      only these codes are offered in the wizard and in the sheet's Cost code column
--   equipment_type  the planner equipment type (history_projects.equipment_type) whose items get this
--                   code filled in automatically
--
-- To offer another code later, flip in_planner (and set equipment_type) in a new migration.
--
-- Same shared reference library as 0004 / 0011: any signed-in user reads it, nobody writes it through
-- the API.

create table cost_codes (
  code text primary key check (code ~ '^[A-Z0-9][A-Z0-9-]*$'),
  description text not null check (length(trim(description)) > 0 and position(',' in description) = 0),
  in_planner boolean not null default false,
  equipment_type text unique check (equipment_type is null or length(trim(equipment_type)) > 0)
);

alter table cost_codes enable row level security;

create policy cost_codes_read on cost_codes
  for select to authenticated using (true);

revoke all on cost_codes from anon, authenticated, public;
grant select on cost_codes to authenticated;

insert into cost_codes (code, description, in_planner, equipment_type) values
  ('ADV',     'Advance Payment',             false, null),
  ('ADV-REC', 'Advance Payment Recovery',    false, null),
  ('AUH',     'Authority',                   false, null),
  ('CHL',     'Chiller',                     true,  'Chiller'),
  ('CLT',     'Colling Tower',               false, null),
  ('CONS',    'Consultancy Fees',            false, null),
  ('CRAC',    'CRAC/CRAH/FWU',               false, null),
  ('CSA',     'Civil & Structural',          false, null),
  ('DU',      'Coolant & Distribution Unit', false, null),
  ('ELE',     'Elevator',                    true,  'Elevator'),
  ('GEN',     'Generator',                   true,  'Diesel generator'),
  ('HVS',     'HV SiwtchGear',               true,  'HV switchgear'),
  ('POW',     'Power Skid',                  false, null),
  ('TRF',     'Transformer',                 true,  'Power transformer'),
  ('UPS',     'UPS & Battery System',        false, null);
