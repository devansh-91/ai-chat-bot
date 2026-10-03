-- Activity monitor: users write their own activity, only admins can read it. Run: npx supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com', '{"full_name":"Alice"}'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.com',   '{"full_name":"Bob"}'),
  ('33333333-3333-3333-3333-333333333333', 'admin@example.com', '{"full_name":"Admin"}');
update public.profiles set role = 'admin' where id = '33333333-3333-3333-3333-333333333333';

-- ── Alice works ──
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

select lives_ok($$
  insert into public.activity_events (client_id, kind, meta, device_kind)
  values (gen_random_uuid(), 'reply', '{"model":"qwen","ttft_ms":420}', 'mobile'),
         (gen_random_uuid(), 'message_sent', '{"persona":"tutor","chars":42}', 'mobile')
$$, 'user can log her own activity');

select lives_ok($$
  insert into public.user_presence (status, page, model, device_kind)
  values ('typing', '/c/:id', 'qwen', 'mobile')
  on conflict (user_id) do update set status = excluded.status
$$, 'user can upsert her own presence');
select lives_ok($$
  insert into public.user_presence (status) values ('generating')
  on conflict (user_id) do update set status = excluded.status
$$, 'presence upsert updates the existing row');

select throws_ok($$
  insert into public.activity_events (user_id, client_id, kind) values ('22222222-2222-2222-2222-222222222222', gen_random_uuid(), 'reply')
$$, '42501', null, 'user cannot log activity as someone else');

select throws_ok($$
  insert into public.activity_events (client_id, kind) values (gen_random_uuid(), 'hack_the_planet')
$$, '23514', null, 'unknown event kinds are rejected');

select throws_ok($$
  insert into public.activity_events (client_id, kind, meta) values (gen_random_uuid(), 'reply', jsonb_build_object('blob', repeat('x', 5000)))
$$, '23514', null, 'oversized metadata (e.g. smuggled message text) is rejected');

select is((select count(*)::int from public.activity_events), 2, 'user can read only her own activity');
select throws_ok($$ select * from public.admin_live_users() $$, '42501', null, 'non-admin cannot see live users');
select throws_ok($$ select * from public.admin_activity_feed() $$, '42501', null, 'non-admin cannot read the feed');
select throws_ok($$ select public.admin_activity_stats() $$, '42501', null, 'non-admin cannot read activity stats');

-- ── Bob ──
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is((select count(*)::int from public.user_presence), 0, 'bob cannot see alice''s presence');
select is((select count(*)::int from public.activity_events), 0, 'bob cannot see alice''s activity');
update public.user_presence set status = 'offline';
reset role;
select is((select status from public.user_presence where user_id = '11111111-1111-1111-1111-111111111111'), 'generating',
  'bob cannot change alice''s presence');
set local role authenticated;

-- ── Admin ──
set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
select is(
  (select status || '|' || online::text from public.admin_live_users() where user_id = '11111111-1111-1111-1111-111111111111'),
  'generating|true', 'admin sees alice online and generating');
select is((select count(*)::int from public.admin_activity_feed(only_user => '11111111-1111-1111-1111-111111111111')), 2,
  'admin sees alice''s activity feed');
select is((public.admin_activity_stats() #>> '{by_kind,reply}')::int, 1, 'admin stats count replies by kind');

-- ── retention ──
reset role;
insert into public.activity_events (user_id, client_id, kind, created_at)
values ('22222222-2222-2222-2222-222222222222', gen_random_uuid(), 'page_view', now() - interval '16 days');
select public.purge_expired();
select is((select count(*)::int from public.activity_events where created_at < now() - interval '15 days'), 0,
  'activity older than 15 days is purged');

select * from finish();
rollback;
