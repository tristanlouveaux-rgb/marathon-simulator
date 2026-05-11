-- Coach chat usage rate-limiting table
-- Tracks daily call counts per user for the coach-chat edge function (30/day limit).
-- The edge function calls increment_coach_chat_usage() which upserts atomically.

create table if not exists coach_chat_usage (
  user_id  uuid    not null references auth.users(id) on delete cascade,
  date     date    not null,
  call_count integer not null default 0,
  primary key (user_id, date)
);

alter table coach_chat_usage enable row level security;

-- Users can only read their own usage row (edge function bypasses RLS via service role).
create policy "Users can read own usage"
  on coach_chat_usage for select
  using (auth.uid() = user_id);

-- RPC function called by the edge function (service role) to atomically increment and return
-- the new call count. Returns the count AFTER increment so the caller can reject at > limit.
create or replace function increment_coach_chat_usage(p_user_id uuid, p_date date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  new_count integer;
begin
  insert into coach_chat_usage (user_id, date, call_count)
  values (p_user_id, p_date, 1)
  on conflict (user_id, date)
  do update set call_count = coach_chat_usage.call_count + 1
  returning call_count into new_count;

  return new_count;
end;
$$;
