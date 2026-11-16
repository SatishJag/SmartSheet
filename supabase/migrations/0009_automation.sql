-- Automation: rules, run log, notifications, update / approval requests, row locks, copy-row function.
-- (0007 and 0008 belong to other work units.) Same posture as 0002 / 0006: owner-only row-level
-- security, nothing at all for anon / public.
--
-- Public links (update requests, approvals) are NEVER served from these tables to a browser: a link
-- carries a 256-bit random token, only its sha256 is stored (`token_hash`), and the planning server
-- (service role) looks it up. A signed-in user may list their own requests but cannot read the hash,
-- and cannot create or change them except to revoke a pending one.

-- ---------------------------------------------------------------------------------------------
-- Rules: a trigger, optional conditions and one action, as JSON (shapes: src/automation/types.ts).
-- ---------------------------------------------------------------------------------------------
create table automation_rules (
  id uuid primary key default gen_random_uuid(),
  sheet_id uuid not null references sheets (id) on delete cascade,
  owner_id uuid not null default auth.uid(),
  workspace_id uuid not null default auth.uid(),
  name text not null check (length(trim(name)) > 0 and length(name) <= 100),
  enabled boolean not null default true,
  trigger jsonb not null check (
    jsonb_typeof(trigger) = 'object'
    and trigger ->> 'type' in ('row_added', 'row_changed', 'cell_becomes', 'date', 'schedule')
  ),
  conditions jsonb check (conditions is null or jsonb_typeof(conditions) = 'object'),
  action jsonb not null check (
    jsonb_typeof(action) = 'object'
    and action ->> 'type' in ('notify', 'update_request', 'approval', 'lock', 'move', 'copy', 'record_date')
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_run_at timestamptz,
  unique (id, sheet_id)
);
create index automation_rules_sheet_id_idx on automation_rules (sheet_id);
create index automation_rules_owner_enabled_idx on automation_rules (owner_id) where enabled;

-- ---------------------------------------------------------------------------------------------
-- Run log: append-only. rule_id / row_id have no foreign key: the history outlives the rule or row.
-- `dedup_key` makes a time based run happen once: the unique index refuses the second claim.
-- ---------------------------------------------------------------------------------------------
create table automation_runs (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid,
  rule_name text not null,
  sheet_id uuid not null references sheets (id) on delete cascade,
  owner_id uuid not null default auth.uid(),
  workspace_id uuid not null default auth.uid(),
  row_id uuid,
  source text not null check (source in ('browser', 'server', 'test')),
  outcome text not null check (outcome in ('done', 'skipped', 'error', 'dry_run')),
  detail jsonb not null default '{}'::jsonb,
  dedup_key text check (dedup_key is null or length(dedup_key) <= 300),
  created_at timestamptz not null default now()
);
create unique index automation_runs_dedup_key_idx on automation_runs (dedup_key) where dedup_key is not null;
create index automation_runs_sheet_created_idx on automation_runs (sheet_id, created_at desc);
create index automation_runs_rule_created_idx on automation_runs (rule_id, created_at desc);

-- ---------------------------------------------------------------------------------------------
-- Notifications. channel 'app' shows in the notification centre of owner_id; channel 'email' is an
-- outbox row the server delivers (immediately, or at deliver_after for digests).
-- ---------------------------------------------------------------------------------------------
create table notifications (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  sheet_id uuid references sheets (id) on delete cascade,
  row_id uuid,
  rule_id uuid,
  channel text not null check (channel in ('app', 'email')),
  kind text not null default 'rule' check (kind in ('rule', 'update_request', 'approval', 'system')),
  recipient_email text check (recipient_email is null or length(recipient_email) <= 320),
  title text not null check (length(title) <= 200),
  body text not null default '' check (length(body) <= 5000),
  payload jsonb not null default '{}'::jsonb,
  frequency text not null default 'immediately' check (frequency in ('immediately', 'daily', 'weekly')),
  deliver_after timestamptz not null default now(),
  delivery_status text not null default 'pending' check (delivery_status in ('pending', 'sent', 'simulated', 'failed', 'skipped')),
  delivered_at timestamptz,
  delivery_error text,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  check ((channel = 'email') = (recipient_email is not null))
);
create index notifications_app_idx on notifications (owner_id, created_at desc) where channel = 'app';
create index notifications_email_pending_idx on notifications (deliver_after) where channel = 'email' and delivery_status = 'pending';

-- ---------------------------------------------------------------------------------------------
-- Update requests and approval requests (a link that edits chosen columns / decides, no account).
-- ---------------------------------------------------------------------------------------------
create table update_requests (
  id uuid primary key default gen_random_uuid(),
  sheet_id uuid not null,
  row_id uuid not null,
  owner_id uuid not null default auth.uid(),
  workspace_id uuid not null default auth.uid(),
  rule_id uuid,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  recipient_email text not null check (length(recipient_email) <= 320),
  column_ids jsonb not null check (jsonb_typeof(column_ids) = 'array' and jsonb_array_length(column_ids) between 1 and 50),
  message text not null default '' check (length(message) <= 2000),
  expires_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'responded', 'expired', 'revoked')),
  responded_at timestamptz,
  response jsonb,
  created_at timestamptz not null default now(),
  foreign key (row_id, sheet_id) references rows (id, sheet_id) on delete cascade
);
create index update_requests_sheet_idx on update_requests (sheet_id, created_at desc);
create index update_requests_row_idx on update_requests (row_id);

create table approval_requests (
  id uuid primary key default gen_random_uuid(),
  sheet_id uuid not null,
  row_id uuid not null,
  owner_id uuid not null default auth.uid(),
  workspace_id uuid not null default auth.uid(),
  rule_id uuid,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  approver_email text not null check (length(approver_email) <= 320),
  status_column_id uuid not null,
  approved_value text not null check (length(approved_value) between 1 and 200),
  declined_value text not null check (length(declined_value) between 1 and 200),
  show_column_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(show_column_ids) = 'array' and jsonb_array_length(show_column_ids) <= 50),
  message text not null default '' check (length(message) <= 2000),
  expires_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'expired', 'revoked')),
  decision_comment text check (decision_comment is null or length(decision_comment) <= 2000),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (row_id, sheet_id) references rows (id, sheet_id) on delete cascade
);
create index approval_requests_sheet_idx on approval_requests (sheet_id, created_at desc);
create index approval_requests_row_idx on approval_requests (row_id);

-- ---------------------------------------------------------------------------------------------
-- Row locks (the "lock / unlock rows" action). A locked row refuses edits by rules and in the app.
-- ---------------------------------------------------------------------------------------------
create table row_locks (
  row_id uuid primary key,
  sheet_id uuid not null,
  owner_id uuid not null default auth.uid(),
  workspace_id uuid not null default auth.uid(),
  rule_id uuid,
  locked_at timestamptz not null default now(),
  foreign key (row_id, sheet_id) references rows (id, sheet_id) on delete cascade
);
create index row_locks_sheet_idx on row_locks (sheet_id);

-- ---------------------------------------------------------------------------------------------
-- Row-level security and privileges
-- ---------------------------------------------------------------------------------------------
alter table automation_rules enable row level security;
alter table automation_runs enable row level security;
alter table notifications enable row level security;
alter table update_requests enable row level security;
alter table approval_requests enable row level security;
alter table row_locks enable row level security;

revoke all on automation_rules, automation_runs, notifications, update_requests, approval_requests, row_locks from anon, public;
-- Supabase's default privileges hand new tables to authenticated: take everything back, then grant exactly what is needed.
revoke all on automation_rules, automation_runs, notifications, update_requests, approval_requests, row_locks from authenticated;

create policy automation_rules_owner on automation_rules
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and workspace_id = (select auth.uid())
    and exists (select 1 from sheets s where s.id = sheet_id and s.owner_id = (select auth.uid()))
  );
grant select, insert, update, delete on automation_rules to authenticated;

-- The run log can be read and appended to by its owner, never changed or deleted.
create policy automation_runs_select on automation_runs
  for select to authenticated using (owner_id = (select auth.uid()));
create policy automation_runs_insert on automation_runs
  for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and workspace_id = (select auth.uid())
    and exists (select 1 from sheets s where s.id = sheet_id and s.owner_id = (select auth.uid()))
  );
grant select, insert on automation_runs to authenticated;

-- Notifications: the owner reads, creates (in-app rows and the e-mail outbox) and deletes their own,
-- and may change ONLY read_at: delivery columns belong to the server.
create policy notifications_owner on notifications
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and (sheet_id is null or exists (select 1 from sheets s where s.id = sheet_id and s.owner_id = (select auth.uid())))
  );
grant select, insert, delete on notifications to authenticated;
grant update (read_at) on notifications to authenticated;

-- Requests: listed by their owner WITHOUT the token hash; the only change a user can make is revoking
-- a pending one. Creating them and recording responses is the server's job (service role).
create policy update_requests_select on update_requests
  for select to authenticated using (owner_id = (select auth.uid()));
create policy update_requests_revoke on update_requests
  for update to authenticated
  using (owner_id = (select auth.uid()) and status = 'pending')
  with check (owner_id = (select auth.uid()) and status = 'revoked');
grant select (id, sheet_id, row_id, owner_id, rule_id, recipient_email, column_ids, message, expires_at, status, responded_at, response, created_at)
  on update_requests to authenticated;
grant update (status) on update_requests to authenticated;

create policy approval_requests_select on approval_requests
  for select to authenticated using (owner_id = (select auth.uid()));
create policy approval_requests_revoke on approval_requests
  for update to authenticated
  using (owner_id = (select auth.uid()) and status = 'pending')
  with check (owner_id = (select auth.uid()) and status = 'revoked');
grant select (id, sheet_id, row_id, owner_id, rule_id, approver_email, status_column_id, approved_value, declined_value, show_column_ids, message, expires_at, status, decision_comment, decided_at, created_at)
  on approval_requests to authenticated;
grant update (status) on approval_requests to authenticated;

create policy row_locks_owner on row_locks
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and workspace_id = (select auth.uid())
    and exists (select 1 from sheets s where s.id = sheet_id and s.owner_id = (select auth.uid()))
  );
grant select, insert, update, delete on row_locks to authenticated;

-- ---------------------------------------------------------------------------------------------
-- copy_row_to_sheet: the "copy / move row to another sheet" action in one statement. Cells are mapped
-- by column title (ignoring case) between columns of the same type; predecessor columns and a row's
-- children are not copied (a row with children cannot be moved: that would delete them).
-- SECURITY INVOKER: the caller's row-level security applies, so another user's sheet is refused. The
-- new row takes the SOURCE row's owner (not auth.uid()), so the planning server (service role, no
-- auth.uid()) can run it for the rule's owner.
-- ---------------------------------------------------------------------------------------------
create or replace function public.copy_row_to_sheet(p_row_id uuid, p_target_sheet_id uuid, p_position text, p_move boolean default false)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  src rows%rowtype;
  v_cells jsonb;
  v_new uuid;
begin
  select * into src from rows where id = p_row_id;
  if not found then
    raise exception 'row not found' using errcode = 'P0002';
  end if;
  if src.sheet_id = p_target_sheet_id then
    raise exception 'the target must be a different sheet' using errcode = '22023';
  end if;
  if not exists (select 1 from sheets where id = p_target_sheet_id and owner_id = src.owner_id) then
    raise exception 'target sheet not found' using errcode = 'P0002';
  end if;
  if exists (select 1 from rows where parent_id = p_row_id) then
    raise exception 'a row with sub-rows cannot be copied or moved' using errcode = '22023';
  end if;

  select coalesce(jsonb_object_agg(t.id::text, src.cells -> s.id::text), '{}'::jsonb)
    into v_cells
    from columns s
    join columns t on lower(t.title) = lower(s.title) and t.type = s.type and t.sheet_id = p_target_sheet_id
   where s.sheet_id = src.sheet_id
     and s.type <> 'PREDECESSOR'
     and src.cells ? (s.id::text);

  insert into rows (sheet_id, owner_id, workspace_id, parent_id, position, cells)
    values (p_target_sheet_id, src.owner_id, src.workspace_id, null, p_position, v_cells)
    returning id into v_new;

  if p_move then
    delete from rows where id = p_row_id;
  end if;
  return v_new;
end;
$$;

revoke all on function public.copy_row_to_sheet(uuid, uuid, text, boolean) from public, anon;
grant execute on function public.copy_row_to_sheet(uuid, uuid, text, boolean) to authenticated;
