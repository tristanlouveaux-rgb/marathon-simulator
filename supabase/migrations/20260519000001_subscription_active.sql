-- Subscription entitlement state, written by the RevenueCat webhook.
-- One row per user. Edge functions (coach-chat) read this row via service role
-- to gate AI Coach access; the RevenueCat webhook upserts on purchase events.
--
-- Tier values: 'free' (no active subscription) | 'ai_coach' (active subscription
-- granting the ai_coach entitlement). Future tiers reserve other identifiers.
--
-- Status values:
--   'active'         — paid + not yet cancelled
--   'in_trial'       — 7-day intro offer period, not yet billed
--   'in_grace'       — billing retry window after a failed renewal
--   'cancelled'      — user cancelled but still entitled until valid_until
--   'expired'        — past valid_until, no longer entitled
--   'billing_issue'  — payment failed, retry window exhausted
--
-- valid_until carries the rolling renewal date. The coach-chat gate checks
-- `tier <> 'free' AND (valid_until IS NULL OR valid_until > now())` so an
-- expired row that hasn't been webhook-cleaned-up still denies access.

create table if not exists subscription_active (
  user_id        uuid        not null references auth.users(id) on delete cascade,
  tier           text        not null default 'free',
  status         text        not null default 'expired',
  product_id     text,
  entitlement_id text,
  platform       text,
  valid_until    timestamptz,
  last_event_id  text,
  updated_at     timestamptz not null default now(),
  primary key (user_id)
);

alter table subscription_active enable row level security;

-- Users can read their own row (so the client can render the right paywall /
-- subscriber state without a round trip via the edge function).
create policy "Users read own subscription"
  on subscription_active for select
  using (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE policy — only the service role (RevenueCat webhook)
-- writes to this table. RLS denies all user writes by default.

-- Helpful index for the webhook upsert path (already covered by PK, but the
-- explicit comment documents intent for future maintainers).
create index if not exists idx_subscription_active_updated_at
  on subscription_active (updated_at desc);
