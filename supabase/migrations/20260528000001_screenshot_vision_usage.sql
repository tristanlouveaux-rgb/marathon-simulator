-- Screenshot AI-vision usage rate-limiting table.
-- Tracks daily call counts per user for the screenshot-vision edge function.
-- Vision calls are pricier than text, so the per-user cap is tighter than the
-- coach functions. The edge function calls increment_screenshot_vision_usage()
-- which upserts atomically and returns the post-increment count.

create table if not exists screenshot_vision_usage (
  user_id    uuid    not null references auth.users(id) on delete cascade,
  date       date    not null,
  call_count integer not null default 0,
  primary key (user_id, date)
);

alter table screenshot_vision_usage enable row level security;

-- Users can read their own usage row (the edge function bypasses RLS via the
-- service role).
create policy "Users can read own screenshot vision usage"
  on screenshot_vision_usage for select
  using (auth.uid() = user_id);

-- Atomic increment, returns the new count so the caller can reject at > limit.
create or replace function increment_screenshot_vision_usage(p_user_id uuid, p_date date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  new_count integer;
begin
  insert into screenshot_vision_usage (user_id, date, call_count)
  values (p_user_id, p_date, 1)
  on conflict (user_id, date)
  do update set call_count = screenshot_vision_usage.call_count + 1
  returning call_count into new_count;

  return new_count;
end;
$$;
