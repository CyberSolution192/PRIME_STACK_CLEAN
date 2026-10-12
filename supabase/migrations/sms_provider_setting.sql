-- SMS Gateway: manual provider switching (Arkesel <-> BMS Africa)
-- Safe to run more than once.

-- 1. Default active provider. The code also falls back to 'arkesel' when this
--    row is missing, so this only makes the setting visible/explicit.
insert into public.system_settings (key, value)
values ('sms_provider', 'arkesel')
on conflict (key) do nothing;

-- 2. send-sms already writes a provider name per send; make sure the column exists
--    so the Send Logs tab can show which gateway delivered each message.
alter table public.sms_logs
  add column if not exists provider text;
