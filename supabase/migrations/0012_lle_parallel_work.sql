-- LLE procurement: add the work that runs alongside manufacturing, so a plan has critical AND
-- non-critical activities.
--
-- Until now the catalog was one chain (specification -> ... -> on site), so every activity was on
-- the critical path and the Gantt showed all of them as Critical. Three steps of a real long-lead
-- order do not wait for manufacturing, and are in the Procurement schedule app's equipment
-- schedules too:
--
--   FATPREP   prepare the factory acceptance test scripts and witness plan, once drawings are approved
--   FRTFWD    engage the freight forwarder and arrange export clearance, once the order is awarded
--   SHIPDOC   prepare the shipping documents
--
-- FAT now also waits for its scripts, and release for shipment for the shipping documents, so the
-- three have to finish in time but have float while the equipment is being made.
--
-- Durations are catalog defaults (working days), used where history has no data for the activity.
-- history_activities needs no change: the new codes simply have no history yet.
--
-- The target stays last in the sequence and sequences stay 1..n, so the sequence is moved aside
-- first (a unique key on (schedule_type, sequence) forbids two rows sharing a number mid-update).

update activity_catalog set sequence = sequence + 1000 where schedule_type = 'lle-procurement';

insert into activity_catalog (schedule_type, code, name, phase, sequence, default_links, default_days, is_target) values
  ('lle-procurement', 'FATPREP', 'Prepare FAT test scripts and witness plan', 'Quality', 2001,
   '[{"from":"DWGAPP","type":"FS","lagDays":0}]', 10, false),
  ('lle-procurement', 'FRTFWD', 'Engage freight forwarder and arrange export clearance', 'Logistics', 2002,
   '[{"from":"AWARD","type":"FS","lagDays":0}]', 5, false),
  ('lle-procurement', 'SHIPDOC', 'Prepare shipping documents', 'Logistics', 2003,
   '[{"from":"FRTFWD","type":"FS","lagDays":0}]', 5, false);

update activity_catalog
   set default_links = '[{"from":"MFG","type":"FS","lagDays":0},{"from":"FATPREP","type":"FS","lagDays":0}]'
 where schedule_type = 'lle-procurement' and code = 'FAT';

update activity_catalog
   set default_links = '[{"from":"FAT","type":"FS","lagDays":0},{"from":"SHIPDOC","type":"FS","lagDays":0}]'
 where schedule_type = 'lle-procurement' and code = 'RELEASE';

update activity_catalog c
   set sequence = v.sequence
  from (values
    ('SPEC', 1), ('RFQ', 2), ('BIDEVAL', 3), ('AWARD', 4), ('DWGSUB', 5), ('DWGAPP', 6), ('RAWMAT', 7), ('MFG', 8),
    ('FATPREP', 9), ('FRTFWD', 10), ('SHIPDOC', 11), ('FAT', 12), ('RELEASE', 13), ('SHIP', 14), ('CUSTOMS', 15),
    ('DELIVER', 16), ('ONSITE', 17)
  ) as v(code, sequence)
 where c.schedule_type = 'lle-procurement' and c.code = v.code;
