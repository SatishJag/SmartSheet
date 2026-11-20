-- Sharing: a sheet's owner can give other users view or edit access.
--   sheet_members   who a sheet is shared with, and their role ('viewer' reads, 'editor' also writes)
--   sheet_role()    the caller's role on a sheet: 'owner', 'editor', 'viewer' or null (no access)
--   share_sheet()   owner-only, by email; the only way to add or change a member
-- Child rows keep owner_id = the SHEET owner (the app copies it from the sheet), whoever edits them.
-- Only the owner can rename, change settings of, delete or share a sheet.

create table sheet_members (
  sheet_id uuid not null references sheets (id) on delete cascade,
  user_id uuid not null,
  email text not null,
  role text not null check (role in ('viewer', 'editor')),
  created_at timestamptz not null default now(),
  primary key (sheet_id, user_id)
);
create index sheet_members_user_id_idx on sheet_members (user_id);

-- security definer so the policies below can consult sheets and sheet_members without
-- recursing into each other's policies; they only ever return facts about the caller.
create function sheet_role(p_sheet uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case when s.owner_id = (select auth.uid()) then 'owner' else m.role end
  from public.sheets s
  left join public.sheet_members m on m.sheet_id = s.id and m.user_id = (select auth.uid())
  where s.id = p_sheet
$$;

create function sheet_owner_id(p_sheet uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select owner_id from public.sheets where id = p_sheet
$$;

create function share_sheet(p_sheet uuid, p_email text, p_role text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(trim(p_email));
  v_user uuid;
begin
  if public.sheet_role(p_sheet) is distinct from 'owner' then
    raise exception 'Only the sheet owner can share it' using errcode = '42501';
  end if;
  if p_role not in ('viewer', 'editor') then
    raise exception 'Role must be viewer or editor';
  end if;
  select id into v_user from auth.users where lower(email) = v_email;
  if v_user is null then
    raise exception 'No account found for %', v_email;
  end if;
  if v_user = (select auth.uid()) then
    raise exception 'You already own this sheet';
  end if;
  insert into public.sheet_members (sheet_id, user_id, email, role)
  values (p_sheet, v_user, v_email, p_role)
  on conflict (sheet_id, user_id) do update set role = excluded.role;
end $$;

revoke all on function sheet_role(uuid), sheet_owner_id(uuid), share_sheet(uuid, text, text) from public, anon;
grant execute on function sheet_role(uuid), sheet_owner_id(uuid), share_sheet(uuid, text, text) to authenticated;

alter table sheet_members enable row level security;
revoke all on sheet_members from anon, public;
-- No insert/update policy: members are added only through share_sheet().
revoke insert, update on sheet_members from authenticated;
grant select, delete on sheet_members to authenticated;

-- The owner sees every member of their sheet; a member sees (and may delete, i.e. leave) their own row.
create policy members_select on sheet_members for select to authenticated
  using (user_id = (select auth.uid()) or public.sheet_role(sheet_id) = 'owner');
create policy members_delete on sheet_members for delete to authenticated
  using (user_id = (select auth.uid()) or public.sheet_role(sheet_id) = 'owner');

-- sheets ------------------------------------------------------------------------------------
drop policy sheets_owner on sheets;
create policy sheets_select on sheets for select to authenticated
  using (public.sheet_role(id) is not null);
create policy sheets_insert on sheets for insert to authenticated
  with check (owner_id = (select auth.uid()) and workspace_id = (select auth.uid()));
create policy sheets_update on sheets for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()) and workspace_id = (select auth.uid()));
create policy sheets_delete on sheets for delete to authenticated
  using (owner_id = (select auth.uid()));

-- columns, rows, dependencies: read with any role, write as owner or editor ---------------------
-- The with-check also pins owner_id/workspace_id to the sheet owner, so an editor cannot claim a row.
do $$
declare t text;
begin
  foreach t in array array['columns', 'rows', 'dependencies'] loop
    execute format('drop policy %I on %I', t || '_owner', t);
    execute format(
      'create policy %I on %I for select to authenticated using (public.sheet_role(sheet_id) is not null)',
      t || '_select', t);
    execute format(
      'create policy %I on %I for insert to authenticated with check (
         public.sheet_role(sheet_id) in (''owner'', ''editor'')
         and owner_id = public.sheet_owner_id(sheet_id) and workspace_id = owner_id)',
      t || '_insert', t);
    execute format(
      'create policy %I on %I for update to authenticated
         using (public.sheet_role(sheet_id) in (''owner'', ''editor''))
         with check (
           public.sheet_role(sheet_id) in (''owner'', ''editor'')
           and owner_id = public.sheet_owner_id(sheet_id) and workspace_id = owner_id)',
      t || '_update', t);
    execute format(
      'create policy %I on %I for delete to authenticated using (public.sheet_role(sheet_id) in (''owner'', ''editor''))',
      t || '_delete', t);
  end loop;
end $$;
