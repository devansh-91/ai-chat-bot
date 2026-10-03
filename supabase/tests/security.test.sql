-- Security & lifecycle tests. Run with: npx supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(27);

-- Fixtures: two normal users and one admin.
insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com', '{"full_name":"Alice"}'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.com',   '{"full_name":"Bob"}'),
  ('33333333-3333-3333-3333-333333333333', 'admin@example.com', '{"full_name":"Admin"}');
update public.profiles set role = 'admin' where id = '33333333-3333-3333-3333-333333333333';

select is((select display_name from public.profiles where id = '11111111-1111-1111-1111-111111111111'),
  'Alice', 'signup trigger creates profile from Google metadata');

-- JWT hook embeds role claim
select is(
  public.custom_access_token_hook('{"user_id":"33333333-3333-3333-3333-333333333333","claims":{"sub":"x"}}'::jsonb)
    #>> '{claims,user_role}', 'admin', 'access token hook signs admin role into JWT');
select is(
  public.custom_access_token_hook('{"user_id":"11111111-1111-1111-1111-111111111111","claims":{"sub":"x"}}'::jsonb)
    #>> '{claims,user_role}', 'user', 'access token hook signs user role into JWT');

-- ── act as Alice ──
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","user_role":"user"}';

insert into public.conversations (id, title, created_at, updated_at)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'Alice chat', now(), now());
insert into public.messages (id, conversation_id, role, content)
values ('aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-000000000001', 'user', 'hello');

select is((select count(*)::int from public.conversations), 1, 'alice sees her conversation');

select throws_ok(
  $$ insert into public.conversations (id, user_id, title) values ('aaaaaaaa-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'spoof') $$,
  '42501', null, 'alice cannot create a conversation owned by bob');

select throws_ok(
  $$ update public.profiles set role = 'admin' where id = '11111111-1111-1111-1111-111111111111' $$,
  '42501', null, 'alice cannot escalate her own role');

select lives_ok(
  $$ update public.profiles set display_name = 'Alice M' where id = '11111111-1111-1111-1111-111111111111' $$,
  'alice can edit her display name');

select throws_ok($$ select public.admin_overview() $$, '42501', null, 'non-admin cannot call admin_overview');
select throws_ok($$ select * from public.admin_list_users() $$, '42501', null, 'non-admin cannot list users');
select throws_ok(
  $$ select public.admin_set_role('11111111-1111-1111-1111-111111111111', 'admin') $$,
  '42501', null, 'non-admin cannot grant admin');
select throws_ok($$ select public.purge_expired() $$, '42501', null, 'clients cannot call purge_expired directly');

-- Forged claim: a hand-edited token saying user_role=admin is still rejected because RLS reads the table.
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","user_role":"admin"}';
select throws_ok($$ select public.admin_overview() $$, '42501', null, 'forged user_role claim does not grant admin');

select is((select count(*)::int from public.audit_log), 0, 'non-admin cannot read audit log');

-- Future timestamps are clamped so retention cannot be dodged.
insert into public.messages (id, conversation_id, role, content, created_at)
values ('aaaaaaaa-0000-0000-0000-0000000000a2', 'aaaaaaaa-0000-0000-0000-000000000001', 'user', 'from the future', now() + interval '10 years');
select ok((select created_at <= now() from public.messages where id = 'aaaaaaaa-0000-0000-0000-0000000000a2'),
  'future created_at is clamped to server time');

insert into public.telemetry_events (client_id, provider, model, ttft_ms, total_ms, output_tokens, tokens_per_sec)
values (gen_random_uuid(), 'webllm', 'qwen', 420, 2000, 50, 31.5);

-- ── act as Bob ──
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated","user_role":"user"}';

select is((select count(*)::int from public.conversations), 0, 'bob cannot see alice''s conversations');
select is((select count(*)::int from public.messages), 0, 'bob cannot see alice''s messages');
select is((select count(*)::int from public.telemetry_events), 0, 'bob cannot see alice''s telemetry');
select throws_ok(
  $$ insert into public.messages (id, conversation_id, role, content) values ('bbbbbbbb-0000-0000-0000-0000000000b1', 'aaaaaaaa-0000-0000-0000-000000000001', 'user', 'intrusion') $$,
  '42501', null, 'bob cannot write into alice''s conversation');
update public.conversations set title = 'hacked' where id = 'aaaaaaaa-0000-0000-0000-000000000001';
reset role;
select is((select title from public.conversations where id = 'aaaaaaaa-0000-0000-0000-000000000001'), 'Alice chat',
  'bob''s update of alice''s conversation affects nothing');
set local role authenticated;

-- ── act as Admin ──
set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","user_role":"admin"}';

select is((select (public.admin_overview() ->> 'users')::int), 3, 'admin overview counts users');
select is((select count(*)::int from public.admin_list_users()), 3, 'admin lists all users');
select is((select requests::int from public.admin_telemetry_summary()), 1, 'admin sees aggregated telemetry');
select is((select count(*)::int from public.conversations), 0, 'admin still cannot read user chat content');
select lives_ok($$ select public.admin_set_role('22222222-2222-2222-2222-222222222222', 'admin') $$, 'admin can promote bob');
select is((select count(*)::int from public.audit_log where action = 'set_role'), 1, 'role change is audit-logged');

-- ── deletion is sticky and wipes content ──
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","user_role":"user"}';
update public.conversations set deleted_at = now() where id = 'aaaaaaaa-0000-0000-0000-000000000001';
update public.conversations set deleted_at = null, title = 'revived' where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select ok(
  (select deleted_at is not null and title is null from public.conversations where id = 'aaaaaaaa-0000-0000-0000-000000000001')
  and (select count(*) = 0 from public.messages),
  'soft delete wipes messages and cannot be undone by a stale device');

-- ── 15-day purge ──
reset role;
insert into public.conversations (id, user_id, title, created_at, updated_at) values
  ('cccccccc-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'old', now() - interval '20 days', now() - interval '20 days'),
  ('cccccccc-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'fresh', now(), now());
-- bypass the clamp/touch trigger by inserting directly in the past (clamp only prevents the future)
insert into public.messages (id, conversation_id, user_id, role, content, created_at) values
  ('cccccccc-0000-0000-0000-0000000000c1', 'cccccccc-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'user', 'old msg', now() - interval '16 days'),
  ('cccccccc-0000-0000-0000-0000000000c2', 'cccccccc-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'user', 'new msg', now());
select public.purge_expired();
select ok(
  not exists (select 1 from public.conversations where id = 'cccccccc-0000-0000-0000-000000000001')
  and not exists (select 1 from public.messages where id = 'cccccccc-0000-0000-0000-0000000000c1')
  and exists (select 1 from public.messages where id = 'cccccccc-0000-0000-0000-0000000000c2'),
  'purge removes data older than 15 days and keeps recent data');

select * from finish();
rollback;
