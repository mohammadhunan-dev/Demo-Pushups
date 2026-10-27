-- One row per logged set. Totals are computed by summing rows over a time range.
create table public.pushup_entries (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  count      integer not null check (count <> 0 and count between -1000 and 1000),
  created_at timestamptz not null default now()
);

create index pushup_entries_user_id_created_at_idx
  on public.pushup_entries (user_id, created_at);

-- Each user can only see, add, and remove their own entries. No updates: corrections are new rows.
alter table public.pushup_entries enable row level security;

create policy "Users can read their own entries"
  on public.pushup_entries for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can insert their own entries"
  on public.pushup_entries for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own entries"
  on public.pushup_entries for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- Clients may only supply `count`; id, user_id and created_at always come from the server.
revoke all on public.pushup_entries from anon, authenticated;
grant select, delete on public.pushup_entries to authenticated;
grant insert (count) on public.pushup_entries to authenticated;

-- Current vs previous period totals for the calling user, using the caller's local time zone.
-- Weeks start on Sunday. "*_to_date" compares against the previous period up to the same elapsed point.
create or replace function public.get_stats(tz text)
returns json
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  local_now      timestamp := now() at time zone tz;
  day_start      timestamp := date_trunc('day', local_now);
  week_start     timestamp := date_trunc('week', local_now + interval '1 day') - interval '1 day';
  month_start    timestamp := date_trunc('month', local_now);
  prev_day       timestamp := day_start - interval '1 day';
  prev_week      timestamp := week_start - interval '1 week';
  prev_month     timestamp := month_start - interval '1 month';
  window_start   timestamp := least(prev_month, prev_week, day_start - interval '30 days');
  result         json;
begin
  with e as (
    select pe.count, pe.created_at at time zone tz as t
    from public.pushup_entries pe
    where pe.user_id = (select auth.uid())
      and pe.created_at >= window_start at time zone tz
  )
  select json_build_object(
    'today',              coalesce(sum(count) filter (where t >= day_start), 0),
    'yesterday_to_date',  coalesce(sum(count) filter (where t >= prev_day and t < prev_day + (local_now - day_start)), 0),
    'yesterday_total',    coalesce(sum(count) filter (where t >= prev_day and t < day_start), 0),
    'daily_avg_30d',      round(coalesce(sum(count) filter (where t >= day_start - interval '30 days' and t < day_start), 0) / 30.0, 1),
    'week',               coalesce(sum(count) filter (where t >= week_start), 0),
    'last_week_to_date',  coalesce(sum(count) filter (where t >= prev_week and t < prev_week + (local_now - week_start)), 0),
    'last_week_total',    coalesce(sum(count) filter (where t >= prev_week and t < week_start), 0),
    'month',              coalesce(sum(count) filter (where t >= month_start), 0),
    'last_month_to_date', coalesce(sum(count) filter (where t >= prev_month and t < least(prev_month + (local_now - month_start), month_start)), 0),
    'last_month_total',   coalesce(sum(count) filter (where t >= prev_month and t < month_start), 0)
  )
  into result
  from e;

  return result;
end;
$$;

revoke execute on function public.get_stats(text) from public, anon;
grant execute on function public.get_stats(text) to authenticated;
