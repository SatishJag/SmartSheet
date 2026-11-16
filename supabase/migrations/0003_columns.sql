-- Column management: two set-based functions so a column change costs one round trip, not one
-- request per row (a sheet can hold 5,000 rows, and cells live in each row's `cells` JSON).
--
-- Both are SECURITY INVOKER: they run with the caller's privileges, so the row-level security
-- policies of 0002_hardening.sql apply to every row they read or write. Another user's sheet,
-- column or rows are simply invisible to them (0 rows affected), never an error that leaks data.

-- Deletes a column and removes its key from every row's cells, atomically. Idempotent: deleting
-- a column that is already gone (a retried call) or not visible to the caller does nothing.
create or replace function public.delete_column(p_column_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_sheet uuid;
begin
  select sheet_id into v_sheet from columns where id = p_column_id;
  if v_sheet is null then
    return;
  end if;
  update rows
    set cells = cells - p_column_id::text
    where sheet_id = v_sheet and cells ? p_column_id::text;
  delete from columns where id = p_column_id;
end;
$$;

-- Sets one column's value on many rows of a sheet: `p_values` maps row id -> value; a JSON null
-- removes the key (an empty cell). Rows not in the sheet (or not visible) are ignored.
create or replace function public.set_column_cells(p_sheet_id uuid, p_column_id text, p_values jsonb)
returns void
language sql
security invoker
set search_path = public
as $$
  update rows r
    set cells = case
      when jsonb_typeof(v.value) = 'null' then r.cells - p_column_id
      else jsonb_set(r.cells, array[p_column_id], v.value, true)
    end
    from jsonb_each(p_values) v
    where r.sheet_id = p_sheet_id and r.id = v.key::uuid;
$$;

-- Functions are executable by PUBLIC by default; only signed-in users may call these.
revoke all on function public.delete_column(uuid) from public, anon;
revoke all on function public.set_column_cells(uuid, text, jsonb) from public, anon;
grant execute on function public.delete_column(uuid) to authenticated;
grant execute on function public.set_column_cells(uuid, text, jsonb) to authenticated;
