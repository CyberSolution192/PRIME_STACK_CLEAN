-- rate_limit_buckets.sql
-- Backing table for supabase/functions/_shared/rate-limit.ts
--
-- Run this once in your Supabase SQL Editor (Dashboard → SQL Editor → New query).
-- No existing table covers this — api_keys.request_count/window_start only
-- works for partner-API-key traffic, not per-IP or per-user buckets.

create table if not exists public.rate_limit_buckets (
  bucket_key     text primary key,
  window_start   timestamptz not null default now(),
  current_count  integer     not null default 0,
  prev_count     integer     not null default 0,
  updated_at     timestamptz not null default now()
);

-- RLS on, no policies added. Edge Functions use the service-role client,
-- which bypasses RLS — so this table is reachable only from your own
-- server-side code, never from the anon/authenticated frontend directly.
-- (Matches the same posture already verified on wallets/transactions/etc.)
alter table public.rate_limit_buckets enable row level security;

-- Optional but recommended: a scheduled cleanup so this table doesn't grow
-- unbounded with stale IP/user buckets that stopped being active. Safe to
-- run periodically (e.g. a daily cron via pg_cron, or manually).
-- Deletes buckets untouched for more than 24 hours.
--
--   delete from public.rate_limit_buckets
--   where updated_at < now() - interval '24 hours';
