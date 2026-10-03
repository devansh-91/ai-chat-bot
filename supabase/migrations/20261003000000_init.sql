-- Shreyan.ai core schema
-- Security model:
--   * Every table has Row Level Security. The browser only ever holds the anon key + the user's JWT,
--     so all authorization is enforced here, not in the frontend.
--   * Roles live in public.profiles.role and are mirrored into the signed JWT (`user_role` claim) by
--     custom_access_token_hook. RLS uses is_admin(), which reads the table, so a demotion is immediate
--     even if an old token still carries `user_role = admin`.
--   * Users cannot change their own role: column-level UPDATE privilege excludes `role`.
--   * Retention: everything user-generated is hard-deleted after 15 days by pg_cron (purge_expired).

-- ───────────────────────────── Roles & profiles ─────────────────────────────
create type public.app_role as enum ('user', 'admin');

create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  email        text,
  display_name text,
  avatar_url   text,
  role         public.app_role not null default 'user',
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz
);

alter table public.profiles enable row level security;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

create policy "profiles: read own or admin"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));

create policy "profiles: update own"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- Only these columns are user-editable; `role` can only change via admin_set_role().
revoke update on public.profiles from authenticated, anon;
grant update (display_name, avatar_url, last_seen_at) on public.profiles to authenticated;

-- Create a profile row for each new auth user (Google sign-in included).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data ->> 'avatar_url'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Custom access token hook: signs the role into the JWT so the client can route without a round-trip.
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  claims jsonb;
  user_role public.app_role;
begin
  select role into user_role from public.profiles where id = (event ->> 'user_id')::uuid;
  claims := event -> 'claims';
  claims := jsonb_set(claims, '{user_role}', to_jsonb(coalesce(user_role, 'user'::public.app_role)));
  return jsonb_set(event, '{claims}', claims);
end;
$$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook from authenticated, anon, public;
grant select on table public.profiles to supabase_auth_admin;
create policy "profiles: auth admin reads roles"
  on public.profiles for select to supabase_auth_admin
  using (true);

-- ───────────────────────────── Sync bookkeeping ─────────────────────────────
-- server_updated_at is the sync cursor. It is always set by the server clock, so devices with
-- skewed clocks or rows written while offline are still picked up by other devices.
create or replace function public.touch_server_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.server_updated_at := now();
  -- Client timestamps are kept for ordering, but never allowed in the future: retention is
  -- computed from them, so a forged future timestamp must not be able to dodge the purge.
  if tg_table_name = 'messages' then
    new.created_at := least(new.created_at, now());
  elsif tg_table_name = 'conversations' then
    new.created_at := least(new.created_at, now());
    new.updated_at := least(new.updated_at, now());
  end if;
  return new;
end;
$$;

-- ───────────────────────────── Conversations ─────────────────────────────
create table public.conversations (
  id                uuid primary key,
  user_id           uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title             text,
  persona           text not null default 'assistant',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  server_updated_at timestamptz not null default now()
);

create index conversations_user_cursor on public.conversations (user_id, server_updated_at);
create index conversations_updated on public.conversations (updated_at);

create trigger conversations_touch
  before insert or update on public.conversations
  for each row execute function public.touch_server_updated_at();

alter table public.conversations enable row level security;

create policy "conversations: owner select"
  on public.conversations for select to authenticated
  using (user_id = (select auth.uid()));
create policy "conversations: owner insert"
  on public.conversations for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "conversations: owner update"
  on public.conversations for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
-- No DELETE policy: clients soft-delete (deleted_at) so the tombstone syncs to other devices.

-- ───────────────────────────── Messages ─────────────────────────────
create table public.messages (
  id                uuid primary key,
  conversation_id   uuid not null references public.conversations (id) on delete cascade,
  user_id           uuid not null default auth.uid() references auth.users (id) on delete cascade,
  role              text not null check (role in ('user', 'assistant', 'system')),
  content           text not null check (char_length(content) <= 32000),
  model             text,
  created_at        timestamptz not null default now(),
  server_updated_at timestamptz not null default now()
);

create index messages_user_cursor on public.messages (user_id, server_updated_at);
create index messages_conversation on public.messages (conversation_id, created_at);

create trigger messages_touch
  before insert or update on public.messages
  for each row execute function public.touch_server_updated_at();

alter table public.messages enable row level security;

create policy "messages: owner select"
  on public.messages for select to authenticated
  using (user_id = (select auth.uid()));
create policy "messages: owner insert into own conversation"
  on public.messages for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.user_id = (select auth.uid()) and c.deleted_at is null
    )
  );
-- Messages are immutable once synced: no UPDATE/DELETE policies.

-- Soft-deleting a conversation wipes its content immediately; only an empty tombstone remains.
create or replace function public.wipe_deleted_conversation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Deletion is sticky: a stale device pushing deleted_at = null cannot resurrect a conversation.
  if old.deleted_at is not null then
    new.deleted_at := old.deleted_at;
    new.title := null;
  elsif new.deleted_at is not null then
    delete from public.messages where conversation_id = new.id;
    new.title := null;
  end if;
  return new;
end;
$$;

create trigger conversations_wipe_on_delete
  before update on public.conversations
  for each row execute function public.wipe_deleted_conversation();

-- ───────────────────────────── Telemetry ─────────────────────────────
create table public.telemetry_events (
  id             bigint generated always as identity primary key,
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  client_id      uuid not null,            -- idempotency key generated on device
  provider       text not null,            -- webllm | wllama | ollama
  model          text not null,
  ttft_ms        integer check (ttft_ms >= 0),
  total_ms       integer not null check (total_ms >= 0),
  output_tokens  integer not null default 0 check (output_tokens >= 0),
  tokens_per_sec real,
  device_tier    text,
  device_kind    text,                     -- mobile | desktop
  was_online     boolean not null default true,
  error          text,
  created_at     timestamptz not null default now(),
  unique (user_id, client_id)
);

create index telemetry_created on public.telemetry_events (created_at);

alter table public.telemetry_events enable row level security;

create policy "telemetry: owner insert"
  on public.telemetry_events for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "telemetry: owner or admin select"
  on public.telemetry_events for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

-- ───────────────────────────── Audit log ─────────────────────────────
create table public.audit_log (
  id         bigint generated always as identity primary key,
  actor_id   uuid references auth.users (id) on delete set null,
  action     text not null,
  target     text,
  meta       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.audit_log enable row level security;

create policy "audit: admin select"
  on public.audit_log for select to authenticated
  using ((select public.is_admin()));
-- Inserts only happen inside security-definer functions.

-- ───────────────────────────── Retention (15 days) ─────────────────────────────
create or replace function public.retention_interval()
returns interval
language sql
immutable
as $$ select interval '15 days' $$;

create or replace function public.purge_expired()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cutoff timestamptz := now() - public.retention_interval();
  n_conv integer;
  n_msg integer;
  n_tel integer;
  n_audit integer;
begin
  delete from public.messages where created_at < cutoff;
  get diagnostics n_msg = row_count;
  -- A conversation expires once it has had no activity for 15 days (cascades remaining messages).
  delete from public.conversations where updated_at < cutoff;
  get diagnostics n_conv = row_count;
  delete from public.telemetry_events where created_at < cutoff;
  get diagnostics n_tel = row_count;
  delete from public.audit_log where created_at < cutoff and action <> 'purge';
  get diagnostics n_audit = row_count;

  insert into public.audit_log (actor_id, action, target, meta)
  values (auth.uid(), 'purge', 'all', jsonb_build_object(
    'cutoff', cutoff, 'conversations', n_conv, 'messages', n_msg, 'telemetry', n_tel, 'audit', n_audit));

  return jsonb_build_object('cutoff', cutoff, 'conversations', n_conv, 'messages', n_msg, 'telemetry', n_tel, 'audit', n_audit);
end;
$$;

revoke execute on function public.purge_expired from public, anon, authenticated;

create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;

select cron.schedule('purge-expired-15d', '17 * * * *', $$ select public.purge_expired(); $$);

-- ───────────────────────────── Admin RPCs ─────────────────────────────
-- All admin functions are security definer and start with an is_admin() gate, so calling them
-- with a non-admin JWT raises 42501 regardless of what the frontend does.
create or replace function public.assert_admin()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'admin role required' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.admin_telemetry_summary(since timestamptz default now() - interval '24 hours')
returns table (
  model text,
  provider text,
  requests bigint,
  errors bigint,
  ttft_p50 double precision,
  ttft_p95 double precision,
  total_p50 double precision,
  total_p95 double precision,
  avg_tokens_per_sec double precision,
  sub_800ms_ratio double precision
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.assert_admin();
  return query
    select t.model, t.provider,
           count(*),
           count(*) filter (where t.error is not null),
           percentile_cont(0.5)  within group (order by t.ttft_ms),
           percentile_cont(0.95) within group (order by t.ttft_ms),
           percentile_cont(0.5)  within group (order by t.total_ms),
           percentile_cont(0.95) within group (order by t.total_ms),
           avg(t.tokens_per_sec)::double precision,
           (count(*) filter (where t.ttft_ms < 800))::double precision / nullif(count(t.ttft_ms), 0)
    from public.telemetry_events t
    where t.created_at >= since
    group by t.model, t.provider
    order by count(*) desc;
end;
$$;

create or replace function public.admin_telemetry_timeseries(
  since timestamptz default now() - interval '24 hours',
  bucket_minutes integer default 15
)
returns table (bucket timestamptz, requests bigint, ttft_p50 double precision, ttft_p95 double precision, active_users bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.assert_admin();
  if bucket_minutes < 1 or bucket_minutes > 1440 then
    raise exception 'bucket_minutes out of range' using errcode = '22023';
  end if;
  return query
    select date_bin(make_interval(mins => bucket_minutes), t.created_at, since) as b,
           count(*),
           percentile_cont(0.5)  within group (order by t.ttft_ms),
           percentile_cont(0.95) within group (order by t.ttft_ms),
           count(distinct t.user_id)
    from public.telemetry_events t
    where t.created_at >= since
    group by b
    order by b;
end;
$$;

create or replace function public.admin_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.assert_admin();
  return jsonb_build_object(
    'users', (select count(*) from public.profiles),
    'admins', (select count(*) from public.profiles where role = 'admin'),
    'active_24h', (select count(distinct user_id) from public.telemetry_events where created_at > now() - interval '24 hours'),
    'conversations', (select count(*) from public.conversations where deleted_at is null),
    'messages', (select count(*) from public.messages),
    'oldest_message', (select min(created_at) from public.messages),
    'next_purge_cutoff', now() - public.retention_interval(),
    'last_purge', (select to_jsonb(a) from public.audit_log a where action = 'purge' order by created_at desc limit 1)
  );
end;
$$;

create or replace function public.admin_list_users()
returns table (id uuid, email text, display_name text, avatar_url text, role public.app_role,
               created_at timestamptz, last_seen_at timestamptz, requests_24h bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.assert_admin();
  return query
    select p.id, p.email, p.display_name, p.avatar_url, p.role, p.created_at, p.last_seen_at,
           (select count(*) from public.telemetry_events t
             where t.user_id = p.id and t.created_at > now() - interval '24 hours')
    from public.profiles p
    order by p.created_at desc;
end;
$$;

create or replace function public.admin_set_role(target uuid, new_role public.app_role)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_role public.app_role;
begin
  perform public.assert_admin();
  if target = auth.uid() and new_role <> 'admin' then
    raise exception 'admins cannot demote themselves' using errcode = '42501';
  end if;
  select role into old_role from public.profiles where id = target for update;
  if not found then
    raise exception 'user not found' using errcode = 'P0002';
  end if;
  update public.profiles set role = new_role where id = target;
  insert into public.audit_log (actor_id, action, target, meta)
  values (auth.uid(), 'set_role', target::text, jsonb_build_object('from', old_role, 'to', new_role));
end;
$$;

create or replace function public.admin_run_purge()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_admin();
  return public.purge_expired();
end;
$$;

revoke execute on function
  public.admin_telemetry_summary, public.admin_telemetry_timeseries, public.admin_overview,
  public.admin_list_users, public.admin_set_role, public.admin_run_purge
  from public, anon;
grant execute on function
  public.admin_telemetry_summary, public.admin_telemetry_timeseries, public.admin_overview,
  public.admin_list_users, public.admin_set_role, public.admin_run_purge
  to authenticated;

-- ───────────────────────────── Realtime ─────────────────────────────
-- Live cross-device sync. Realtime respects the RLS policies above.
alter publication supabase_realtime add table public.conversations, public.messages;
