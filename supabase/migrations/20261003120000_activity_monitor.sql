-- Admin activity monitor: who is online, what they are doing, and a live event feed.
-- Privacy rule: only metadata is recorded (event kind, model, latency, device, sizes). Never message text.
-- Users can write and read their own activity but nobody else's; admins can read everyone's,
-- and Realtime delivers changes only to subscribers whose RLS select policy passes (admins).

-- ───────────────────────────── Activity events ─────────────────────────────
create table public.activity_events (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  client_id   uuid not null,                       -- idempotency key generated on device
  kind        text not null check (kind in (
                'session_start', 'sign_in', 'sign_out',
                'chat_created', 'chat_deleted', 'persona_changed',
                'message_sent', 'reply', 'reply_error', 'reply_stopped',
                'model_loaded', 'model_error',
                'voice_input', 'voice_output', 'page_view')),
  meta        jsonb not null default '{}'::jsonb check (pg_column_size(meta) <= 2048),
  device_kind text check (device_kind in ('mobile', 'desktop')),
  created_at  timestamptz not null default now(),
  unique (user_id, client_id)
);

create index activity_created on public.activity_events (created_at desc);
create index activity_user_created on public.activity_events (user_id, created_at desc);

-- Events may be queued offline, so created_at comes from the device, but never from the future.
create or replace function public.clamp_created_at()
returns trigger
language plpgsql
as $$
begin
  new.created_at := least(new.created_at, now());
  return new;
end;
$$;

create trigger activity_clamp
  before insert on public.activity_events
  for each row execute function public.clamp_created_at();

alter table public.activity_events enable row level security;

create policy "activity: owner insert"
  on public.activity_events for insert to authenticated
  with check (user_id = (select auth.uid()));
-- Users may read their own activity (also required by insert-or-ignore uploads); admins read everyone's.
create policy "activity: owner or admin select"
  on public.activity_events for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

-- ───────────────────────────── Presence (one row per user) ─────────────────────────────
create table public.user_presence (
  user_id     uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  status      text not null check (status in ('active', 'idle', 'typing', 'generating', 'listening', 'offline')),
  page        text check (char_length(page) <= 64),
  model       text check (char_length(model) <= 128),
  device_kind text check (device_kind in ('mobile', 'desktop')),
  device_tier text check (char_length(device_tier) <= 16),
  updated_at  timestamptz not null default now()
);

-- Heartbeat time always comes from the server clock.
create or replace function public.touch_presence()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger presence_touch
  before insert or update on public.user_presence
  for each row execute function public.touch_presence();

alter table public.user_presence enable row level security;

-- Upsert (INSERT ... ON CONFLICT DO UPDATE) needs the owner to see their own row.
create policy "presence: owner or admin select"
  on public.user_presence for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));
create policy "presence: owner insert"
  on public.user_presence for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "presence: owner update"
  on public.user_presence for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ───────────────────────────── Admin RPCs ─────────────────────────────
-- Seconds without a heartbeat after which a user is shown as offline.
create or replace function public.presence_timeout()
returns interval
language sql
immutable
as $$ select interval '75 seconds' $$;

create or replace function public.admin_live_users()
returns table (
  user_id uuid, email text, display_name text, avatar_url text, role public.app_role,
  status text, page text, model text, device_kind text, device_tier text,
  updated_at timestamptz, online boolean, events_1h bigint, last_event text, last_event_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.assert_admin();
  return query
    select p.id, p.email, p.display_name, p.avatar_url, p.role,
           case when up.updated_at > now() - public.presence_timeout() then up.status else 'offline' end,
           up.page, up.model, up.device_kind, up.device_tier, up.updated_at,
           coalesce(up.updated_at > now() - public.presence_timeout() and up.status <> 'offline', false),
           (select count(*) from public.activity_events a
             where a.user_id = p.id and a.created_at > now() - interval '1 hour'),
           le.kind, le.created_at
    from public.profiles p
    left join public.user_presence up on up.user_id = p.id
    left join lateral (
      select a.kind, a.created_at from public.activity_events a
      where a.user_id = p.id order by a.created_at desc limit 1
    ) le on true
    order by 12 desc, coalesce(up.updated_at, le.created_at, p.created_at) desc nulls last;
end;
$$;

create or replace function public.admin_activity_feed(
  since timestamptz default now() - interval '24 hours',
  max_rows integer default 200,
  only_user uuid default null,
  only_kind text default null
)
returns table (
  id bigint, user_id uuid, email text, display_name text, avatar_url text,
  kind text, meta jsonb, device_kind text, created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.assert_admin();
  return query
    select a.id, a.user_id, p.email, p.display_name, p.avatar_url, a.kind, a.meta, a.device_kind, a.created_at
    from public.activity_events a
    join public.profiles p on p.id = a.user_id
    where a.created_at >= since
      and (only_user is null or a.user_id = only_user)
      and (only_kind is null or a.kind = only_kind)
    order by a.created_at desc, a.id desc
    limit least(greatest(max_rows, 1), 1000);
end;
$$;

create or replace function public.admin_activity_stats(since timestamptz default now() - interval '24 hours')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.assert_admin();
  return jsonb_build_object(
    'online_now', (select count(*) from public.user_presence
                    where updated_at > now() - public.presence_timeout() and status <> 'offline'),
    'active_users', (select count(distinct user_id) from public.activity_events where created_at >= since),
    'by_kind', coalesce((select jsonb_object_agg(kind, n) from (
        select kind, count(*) as n from public.activity_events where created_at >= since group by kind) k), '{}'::jsonb),
    'by_device', coalesce((select jsonb_object_agg(coalesce(device_kind, 'unknown'), n) from (
        select device_kind, count(distinct user_id) as n from public.activity_events where created_at >= since group by device_kind) d), '{}'::jsonb),
    'top_models', coalesce((select jsonb_agg(jsonb_build_object('model', model, 'replies', n) order by n desc) from (
        select meta ->> 'model' as model, count(*) as n from public.activity_events
        where created_at >= since and kind = 'reply' and meta ? 'model'
        group by 1 order by 2 desc limit 5) m), '[]'::jsonb),
    'top_personas', coalesce((select jsonb_agg(jsonb_build_object('persona', persona, 'messages', n) order by n desc) from (
        select meta ->> 'persona' as persona, count(*) as n from public.activity_events
        where created_at >= since and kind = 'message_sent' and meta ? 'persona'
        group by 1 order by 2 desc limit 5) pe), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.admin_live_users, public.admin_activity_feed, public.admin_activity_stats from public, anon;
grant execute on function public.admin_live_users, public.admin_activity_feed, public.admin_activity_stats to authenticated;

-- ───────────────────────────── Retention ─────────────────────────────
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
  n_act integer;
  n_pres integer;
  n_audit integer;
  result jsonb;
begin
  delete from public.messages where created_at < cutoff;
  get diagnostics n_msg = row_count;
  -- A conversation expires once it has had no activity for 15 days (cascades remaining messages).
  delete from public.conversations where updated_at < cutoff;
  get diagnostics n_conv = row_count;
  delete from public.telemetry_events where created_at < cutoff;
  get diagnostics n_tel = row_count;
  delete from public.activity_events where created_at < cutoff;
  get diagnostics n_act = row_count;
  delete from public.user_presence where updated_at < cutoff;
  get diagnostics n_pres = row_count;
  delete from public.audit_log where created_at < cutoff and action <> 'purge';
  get diagnostics n_audit = row_count;

  result := jsonb_build_object('cutoff', cutoff, 'conversations', n_conv, 'messages', n_msg, 'telemetry', n_tel,
                               'activity', n_act, 'presence', n_pres, 'audit', n_audit);
  insert into public.audit_log (actor_id, action, target, meta) values (auth.uid(), 'purge', 'all', result);
  return result;
end;
$$;

revoke execute on function public.purge_expired from public, anon, authenticated;

-- ───────────────────────────── Realtime ─────────────────────────────
-- Live admin feed. RLS (admin-only select) decides who receives these changes.
alter publication supabase_realtime add table public.activity_events, public.user_presence;
