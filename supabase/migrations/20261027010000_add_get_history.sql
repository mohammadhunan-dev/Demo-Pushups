-- Zero-filled totals per bucket for one period of the calling user's history, in the caller's time zone.
-- period: 'D' = 24 hours of a day, 'W' = 7 days of a week (starting Sunday),
--         'M' = each day of a month, 'Y' = 12 months of a year.
-- page_offset: 0 = the current period, 1 = the one before, and so on.
create or replace function public.get_history(tz text, period text, page_offset integer default 0)
returns table (bucket timestamp, total bigint)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  local_now  timestamp := now() at time zone tz;
  unit       text;
  step       interval;
  period_len interval;
  start_ts   timestamp;
begin
  if page_offset < 0 then
    raise exception 'page_offset must be 0 or greater';
  end if;

  case period
    when 'D' then
      unit := 'hour';  step := interval '1 hour';  period_len := interval '1 day';
      start_ts := date_trunc('day', local_now) - page_offset * interval '1 day';
    when 'W' then
      unit := 'day';   step := interval '1 day';   period_len := interval '1 week';
      start_ts := date_trunc('week', local_now + interval '1 day') - interval '1 day' - page_offset * interval '1 week';
    when 'M' then
      unit := 'day';   step := interval '1 day';   period_len := interval '1 month';
      start_ts := date_trunc('month', local_now) - page_offset * interval '1 month';
    when 'Y' then
      unit := 'month'; step := interval '1 month'; period_len := interval '1 year';
      start_ts := date_trunc('year', local_now) - page_offset * interval '1 year';
    else
      raise exception 'period must be one of D, W, M, Y';
  end case;

  return query
    with buckets as (
      select gs as b
      from generate_series(start_ts, start_ts + period_len - step, step) gs
    ),
    sums as (
      select date_trunc(unit, pe.created_at at time zone tz) as b, sum(pe.count) as s
      from public.pushup_entries pe
      where pe.user_id = (select auth.uid())
        and pe.created_at >= start_ts at time zone tz
        and pe.created_at <  (start_ts + period_len) at time zone tz
      group by 1
    )
    select buckets.b, coalesce(sums.s, 0)::bigint
    from buckets
    left join sums using (b)
    order by buckets.b;
end;
$$;

revoke execute on function public.get_history(text, text, integer) from public, anon;
grant execute on function public.get_history(text, text, integer) to authenticated;
