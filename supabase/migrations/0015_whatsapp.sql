-- WhatsApp assistant (docs/superpowers/specs/2026-11-19-whatsapp-assistant-design.md).
--
--   whatsapp_links           a planner user's verified phone (one phone per user, one user per phone)
--   whatsapp_contacts        an owner's site contacts without a planner account (subcontractors, foremen)
--   whatsapp_codes           one-time LINK / JOIN codes (only their sha256 is stored)
--   whatsapp_sheet_settings  per sheet: alerts, nudges, daily summary, do-not-disturb, task-owner column
--   whatsapp_sessions        conversation state per phone (selected sheet, last numbered list, ...)
--   whatsapp_messages        every inbound and outbound message: the outbox and the activity log
--   whatsapp_nudges          progress nudges sent per task, milestone and phone (reminders, no-response)
--   whatsapp_optouts         phones that said STOP (honoured for every account)
--
-- Phones are stored as digits only, with the country code (E.164 without '+'). Everything the server
-- decides (codes, sessions, opt-outs, delivery columns) is service-role only; a signed-in user reads
-- their own link, settings, contacts and message log and changes only what is theirs to change.

-- notifications: rules may also send on WhatsApp (resolved to a phone by the server at delivery).
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.notifications'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%channel%'
  loop
    execute format('alter table public.notifications drop constraint %I', c.conname);
  end loop;
end $$;
alter table notifications add constraint notifications_channel_check check (channel in ('app', 'email', 'whatsapp'));
alter table notifications add constraint notifications_recipient_check check ((channel in ('email', 'whatsapp')) = (recipient_email is not null));
create index notifications_whatsapp_pending_idx on notifications (deliver_after) where channel = 'whatsapp' and delivery_status = 'pending';

-- ---------------------------------------------------------------------------------------------
create table whatsapp_links (
  user_id uuid primary key,
  phone text not null unique check (phone ~ '^[1-9][0-9]{7,14}$'),
  -- The account's e-mail when it linked (lower case): how a Contact cell finds a linked user's phone.
  email text check (email is null or (length(email) <= 320 and email = lower(email))),
  linked_at timestamptz not null default now()
);
create index whatsapp_links_email_idx on whatsapp_links (email);

create table whatsapp_contacts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  workspace_id uuid not null default auth.uid(),
  name text not null check (length(trim(name)) between 1 and 100),
  email text not null check (email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' and length(email) <= 320 and email = lower(email)),
  phone text not null check (phone ~ '^[1-9][0-9]{7,14}$'),
  status text not null default 'invited' check (status in ('invited', 'active')),
  joined_at timestamptz,
  created_at timestamptz not null default now(),
  unique (owner_id, email),
  unique (owner_id, phone)
);
create index whatsapp_contacts_phone_idx on whatsapp_contacts (phone);

-- A changed phone must join again: the new number has not proven itself.
create function public.whatsapp_contacts_rejoin() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.phone is distinct from old.phone then
    new.status := 'invited';
    new.joined_at := null;
  end if;
  return new;
end $$;
create trigger whatsapp_contacts_rejoin before update on whatsapp_contacts
  for each row execute function public.whatsapp_contacts_rejoin();

create table whatsapp_codes (
  code_hash text primary key check (code_hash ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('link', 'join')),
  user_id uuid,
  contact_id uuid references whatsapp_contacts (id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  check ((kind = 'link') = (user_id is not null)),
  check ((kind = 'join') = (contact_id is not null))
);

create table whatsapp_sheet_settings (
  sheet_id uuid primary key references sheets (id) on delete cascade,
  owner_id uuid not null default auth.uid(),
  workspace_id uuid not null default auth.uid(),
  enabled boolean not null default true,
  delay_alerts boolean not null default true,
  nudges boolean not null default true,
  reminder_hours integer not null default 24 check (reminder_hours between 1 and 168),
  max_reminders integer not null default 2 check (max_reminders between 0 and 10),
  daily_summary boolean not null default true,
  summary_hour integer not null default 8 check (summary_hour between 0 and 23),
  time_zone text not null default 'UTC' check (length(time_zone) between 1 and 64),
  dnd_start text not null default '22:00' check (dnd_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  dnd_end text not null default '07:00' check (dnd_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  owner_column_id uuid,
  updated_at timestamptz not null default now()
);

create table whatsapp_sessions (
  phone text primary key,
  state jsonb not null default '{}'::jsonb check (jsonb_typeof(state) = 'object'),
  last_inbound_at timestamptz,
  updated_at timestamptz not null default now()
);

create table whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  -- The account the message belongs to (its sheet, its quota, its activity log); null for unknown phones.
  owner_id uuid,
  phone text not null,
  direction text not null check (direction in ('in', 'out')),
  kind text not null default 'reply' check (kind in ('reply', 'alert', 'nudge', 'summary', 'rule', 'system')),
  priority text not null default 'MEDIUM' check (priority in ('HIGH', 'MEDIUM', 'LOW')),
  body text not null check (length(body) <= 8000),
  sheet_id uuid,
  row_id uuid,
  status text not null check (status in ('received', 'pending', 'sent', 'simulated', 'failed', 'skipped')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  provider_id text,
  error text,
  dedup_key text check (dedup_key is null or length(dedup_key) <= 300),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create unique index whatsapp_messages_dedup_idx on whatsapp_messages (dedup_key) where dedup_key is not null;
create unique index whatsapp_messages_inbound_idx on whatsapp_messages (provider_id) where direction = 'in' and provider_id is not null;
create index whatsapp_messages_pending_idx on whatsapp_messages (next_attempt_at) where status = 'pending';
create index whatsapp_messages_owner_idx on whatsapp_messages (owner_id, created_at desc);
create index whatsapp_messages_phone_idx on whatsapp_messages (phone, created_at desc);

create table whatsapp_nudges (
  row_id uuid not null,
  milestone integer not null check (milestone in (50, 70, 90)),
  phone text not null,
  sheet_id uuid not null references sheets (id) on delete cascade,
  owner_id uuid not null,
  sent_count integer not null default 1,
  last_sent_at timestamptz not null default now(),
  answered_at timestamptz,
  no_response_at timestamptz,
  primary key (row_id, milestone, phone)
);
create index whatsapp_nudges_sheet_idx on whatsapp_nudges (sheet_id);

create table whatsapp_optouts (
  phone text primary key,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------
-- Row-level security and privileges
-- ---------------------------------------------------------------------------------------------
alter table whatsapp_links enable row level security;
alter table whatsapp_contacts enable row level security;
alter table whatsapp_codes enable row level security;
alter table whatsapp_sheet_settings enable row level security;
alter table whatsapp_sessions enable row level security;
alter table whatsapp_messages enable row level security;
alter table whatsapp_nudges enable row level security;
alter table whatsapp_optouts enable row level security;

revoke all on whatsapp_links, whatsapp_contacts, whatsapp_codes, whatsapp_sheet_settings, whatsapp_sessions,
  whatsapp_messages, whatsapp_nudges, whatsapp_optouts from anon, public, authenticated;
revoke all on function public.whatsapp_contacts_rejoin() from anon, public, authenticated;

-- A user sees and removes their own link; linking itself is the server's job (it saw the phone write).
create policy whatsapp_links_own on whatsapp_links
  for all to authenticated using (user_id = (select auth.uid()));
grant select, delete on whatsapp_links to authenticated;

-- Contacts: the owner manages name / e-mail / phone; status and joined_at belong to the server.
create policy whatsapp_contacts_owner on whatsapp_contacts
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()) and workspace_id = (select auth.uid()));
grant select, delete on whatsapp_contacts to authenticated;
grant insert (id, name, email, phone) on whatsapp_contacts to authenticated;
grant update (name, email, phone) on whatsapp_contacts to authenticated;

create policy whatsapp_sheet_settings_owner on whatsapp_sheet_settings
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and workspace_id = (select auth.uid())
    and exists (select 1 from sheets s where s.id = sheet_id and s.owner_id = (select auth.uid()))
  );
grant select, insert, update, delete on whatsapp_sheet_settings to authenticated;

-- The activity log: read only, the caller's own messages.
create policy whatsapp_messages_owner on whatsapp_messages
  for select to authenticated using (owner_id = (select auth.uid()));
grant select (id, owner_id, phone, direction, kind, priority, body, sheet_id, row_id, status, attempts, error, created_at, sent_at)
  on whatsapp_messages to authenticated;

create policy whatsapp_nudges_owner on whatsapp_nudges
  for select to authenticated using (owner_id = (select auth.uid()));
grant select on whatsapp_nudges to authenticated;

-- whatsapp_codes, whatsapp_sessions and whatsapp_optouts: no policy, no grant (service role only).
