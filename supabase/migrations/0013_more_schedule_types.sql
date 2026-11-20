-- More schedule types for "Plan with AI", and which project types offer them.
--
-- Until now there was one schedule type (LLE procurement) under both project types, so switching
-- the project type changed nothing. The types below come from the Procurement schedule app's stage
-- lists (materials, other equipment, subcontract, consultant) with their logic; the Procurement
-- app leaves every duration open on purpose.
--
--   Data centre : Long-lead equipment, Other equipment, Subcontract, Consultant
--   Properties  : Materials, Long-lead equipment, Subcontract, Consultant
--
-- PLACEHOLDER DEFAULTS, NOT REAL HISTORY: every default_days below is a representative figure in
-- working days so that the planner can draft a first cut. Replace them, or load completed projects
-- into history_projects (the planner prefers history over these defaults, and tells the user when
-- an activity falls back to a default). The descriptions say so, too, where the user picks the type.
--
-- Each type is a chain, as in the source, so every activity is on its critical path; the long-lead
-- equipment type (0012) is the one with parallel work.

alter table schedule_types add column position integer not null default 0;

-- The order the wizard lists them in, and so which one a project type opens on.
update schedule_types set position = 2 where id = 'lle-procurement';

insert into schedule_types (id, name, description, position, project_types) values
  ('materials-procurement', 'Materials procurement', 'Concrete, rebar, cable and other bulk materials: requirement, quotations, award, supply and receipt. Default durations are placeholders until you load your own history.', 1, '{properties}'),
  ('other-equipment-procurement', 'Other equipment procurement', 'Equipment outside the standard long-lead list: specification, tender, award, vendor drawings, manufacture, testing, shipping and receipt. Default durations are placeholders until you load your own history.', 3, '{data-centre}'),
  ('subcontract-procurement', 'Subcontract procurement', 'Subcontract packages: scope, tender, award, submissions, mobilisation and readiness. Default durations are placeholders until you load your own history.', 4, '{data-centre,properties}'),
  ('consultant-appointment', 'Consultant appointment', 'Consultants: brief, proposals, appointment, onboarding and start of service. Default durations are placeholders until you load your own history.', 5, '{data-centre,properties}');

insert into activity_catalog (schedule_type, code, name, phase, sequence, default_links, default_days, is_target) values
  ('materials-procurement', 'DEFINE_REQUIREMENT', 'Define requirement', 'Requirement and sourcing', 1, '[]', 5, false),
  ('materials-procurement', 'RFQ', 'Request for quotation', 'Requirement and sourcing', 2, '[{"from":"DEFINE_REQUIREMENT","type":"FS","lagDays":0}]', 10, false),
  ('materials-procurement', 'EVALUATE', 'Evaluate quotations', 'Requirement and sourcing', 3, '[{"from":"RFQ","type":"FS","lagDays":0}]', 5, false),
  ('materials-procurement', 'AWARD', 'Award', 'Requirement and sourcing', 4, '[{"from":"EVALUATE","type":"FS","lagDays":0}]', 3, false),
  ('materials-procurement', 'SOURCE', 'Manufacture or source', 'Supply', 5, '[{"from":"AWARD","type":"FS","lagDays":0}]', 30, false),
  ('materials-procurement', 'TRANSPORT', 'Transport', 'Supply', 6, '[{"from":"SOURCE","type":"FS","lagDays":0}]', 10, false),
  ('materials-procurement', 'RECEIVE_INSPECT', 'Receive and inspect', 'Supply', 7, '[{"from":"TRANSPORT","type":"FS","lagDays":0}]', 2, true),
  ('other-equipment-procurement', 'DEFINE_SPECIFICATION', 'Define specification', 'Specification and tender', 1, '[]', 15, false),
  ('other-equipment-procurement', 'TENDER', 'Tender', 'Specification and tender', 2, '[{"from":"DEFINE_SPECIFICATION","type":"FS","lagDays":0}]', 30, false),
  ('other-equipment-procurement', 'EVALUATE', 'Evaluate tenders', 'Specification and tender', 3, '[{"from":"TENDER","type":"FS","lagDays":0}]', 10, false),
  ('other-equipment-procurement', 'AWARD', 'Award', 'Specification and tender', 4, '[{"from":"EVALUATE","type":"FS","lagDays":0}]', 5, false),
  ('other-equipment-procurement', 'VENDOR_DRAWINGS', 'Vendor drawing approval', 'Design and manufacture', 5, '[{"from":"AWARD","type":"FS","lagDays":0}]', 20, false),
  ('other-equipment-procurement', 'RELEASE', 'Release for manufacture', 'Design and manufacture', 6, '[{"from":"VENDOR_DRAWINGS","type":"FS","lagDays":0}]', 5, false),
  ('other-equipment-procurement', 'MANUFACTURE', 'Manufacture', 'Design and manufacture', 7, '[{"from":"RELEASE","type":"FS","lagDays":0}]', 90, false),
  ('other-equipment-procurement', 'FAT', 'Factory acceptance test', 'Design and manufacture', 8, '[{"from":"MANUFACTURE","type":"FS","lagDays":0}]', 5, false),
  ('other-equipment-procurement', 'SHIP', 'Ship', 'Delivery', 9, '[{"from":"FAT","type":"FS","lagDays":0}]', 25, false),
  ('other-equipment-procurement', 'CUSTOMS', 'Customs', 'Delivery', 10, '[{"from":"SHIP","type":"FS","lagDays":0}]', 5, false),
  ('other-equipment-procurement', 'RECEIVE_ACCEPT', 'Receive and accept', 'Delivery', 11, '[{"from":"CUSTOMS","type":"FS","lagDays":0}]', 2, true),
  ('subcontract-procurement', 'DEFINE_SCOPE', 'Define scope', 'Scope and tender', 1, '[]', 10, false),
  ('subcontract-procurement', 'PREQUALIFY', 'Prequalify', 'Scope and tender', 2, '[{"from":"DEFINE_SCOPE","type":"FS","lagDays":0}]', 10, false),
  ('subcontract-procurement', 'TENDER', 'Tender', 'Scope and tender', 3, '[{"from":"PREQUALIFY","type":"FS","lagDays":0}]', 20, false),
  ('subcontract-procurement', 'EVALUATE', 'Evaluate', 'Scope and tender', 4, '[{"from":"TENDER","type":"FS","lagDays":0}]', 5, false),
  ('subcontract-procurement', 'NEGOTIATE', 'Negotiate', 'Scope and tender', 5, '[{"from":"EVALUATE","type":"FS","lagDays":0}]', 5, false),
  ('subcontract-procurement', 'AWARD', 'Award', 'Award and mobilisation', 6, '[{"from":"NEGOTIATE","type":"FS","lagDays":0}]', 3, false),
  ('subcontract-procurement', 'APPROVE_SUBMISSIONS', 'Approve submissions', 'Award and mobilisation', 7, '[{"from":"AWARD","type":"FS","lagDays":0}]', 10, false),
  ('subcontract-procurement', 'MOBILISE', 'Mobilise', 'Award and mobilisation', 8, '[{"from":"APPROVE_SUBMISSIONS","type":"FS","lagDays":0}]', 10, false),
  ('subcontract-procurement', 'CONFIRM_READINESS', 'Confirm readiness', 'Award and mobilisation', 9, '[{"from":"MOBILISE","type":"FS","lagDays":0}]', 2, true),
  ('consultant-appointment', 'DEFINE_BRIEF', 'Define brief', 'Brief and selection', 1, '[]', 5, false),
  ('consultant-appointment', 'REQUEST_PROPOSALS', 'Request proposals', 'Brief and selection', 2, '[{"from":"DEFINE_BRIEF","type":"FS","lagDays":0}]', 15, false),
  ('consultant-appointment', 'EVALUATE', 'Evaluate proposals', 'Brief and selection', 3, '[{"from":"REQUEST_PROPOSALS","type":"FS","lagDays":0}]', 5, false),
  ('consultant-appointment', 'NEGOTIATE', 'Negotiate', 'Brief and selection', 4, '[{"from":"EVALUATE","type":"FS","lagDays":0}]', 5, false),
  ('consultant-appointment', 'APPOINT', 'Appoint', 'Appointment', 5, '[{"from":"NEGOTIATE","type":"FS","lagDays":0}]', 3, false),
  ('consultant-appointment', 'ONBOARD', 'Onboard', 'Appointment', 6, '[{"from":"APPOINT","type":"FS","lagDays":0}]', 5, false),
  ('consultant-appointment', 'COMMENCE', 'Commence service', 'Appointment', 7, '[{"from":"ONBOARD","type":"FS","lagDays":0}]', 1, true);
