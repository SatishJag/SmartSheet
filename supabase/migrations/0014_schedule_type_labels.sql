-- What "Plan with AI" calls the thing it plans: equipment, a material, a subcontract package, a consultant.
--
-- The wizard's labels, validation messages and placeholders used to say "equipment" whatever the
-- schedule type, which read wrongly for materials and consultants. Each schedule type now carries its
-- own words; the default (equipment) is what the long-lead equipment type keeps using.
--
--   noun         lower case, singular: used in "Choose the <noun>...", "<Noun> type", "<Noun> name"
--   typeExample  placeholder of the type field
--   nameExample  placeholder of the name field
--
-- The four types from 0013 are set below; src/db/scheduleTypesSync.test.ts checks them against the
-- procurement module's spec (src/procurement/dbCatalog.ts), so the two cannot drift apart.

alter table schedule_types
  add column item_labels jsonb not null
  default '{"noun":"equipment","typeExample":"Gas turbine","nameExample":"400 MVA transformer for substation B"}'::jsonb
  check (
    jsonb_typeof(item_labels) = 'object'
    and jsonb_typeof(item_labels -> 'noun') = 'string'
    and jsonb_typeof(item_labels -> 'typeExample') = 'string'
    and jsonb_typeof(item_labels -> 'nameExample') = 'string'
    and length(trim(item_labels ->> 'noun')) > 0
  );

update schedule_types set item_labels = '{"noun": "material", "typeExample": "Reinforcing steel", "nameExample": "16 mm rebar for the level 3 slab"}' where id = 'materials-procurement';
update schedule_types set item_labels = '{"noun": "equipment", "typeExample": "Cooling skid", "nameExample": "Modular cooling skid for data hall 2"}' where id = 'other-equipment-procurement';
update schedule_types set item_labels = '{"noun": "subcontract package", "typeExample": "Raised floor", "nameExample": "Raised access floor for data hall 2"}' where id = 'subcontract-procurement';
update schedule_types set item_labels = '{"noun": "consultant", "typeExample": "Commissioning agent", "nameExample": "Commissioning agent for data hall 1"}' where id = 'consultant-appointment';
