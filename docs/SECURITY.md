# Security model

| Threat | Mitigation | Proven by |
|---|---|---|
| User reads another user's chats | RLS: `user_id = auth.uid()` on select/insert/update | `supabase/tests/security.test.sql` |
| User writes into someone else's conversation | Insert policy checks the user owns the parent conversation | pgTAP |
| User makes themselves admin | Column-level grant: `role` is not updatable by `authenticated` | pgTAP |
| Forged / stale JWT claiming `user_role=admin` | Admin checks use `is_admin()`, which reads `profiles`; the claim is only a routing hint | pgTAP "forged claim" test |
| Non-admin calls admin endpoints directly | Every `admin_*` RPC starts with `assert_admin()` (SQLSTATE 42501) | pgTAP |
| Admin reads private chats | Not possible: admins only see aggregated telemetry, users and the audit log | pgTAP |
| Data kept forever | 15-day `pg_cron` purge and local purge; future timestamps clamped | pgTAP + unit tests |
| Deleted chat revived by an offline device | Deletion is enforced by a trigger and can't be undone | pgTAP + integration test |
| Shared device leaks chats after sign-out | Sign-out wipes that account's local data | unit test |
| Role changes not traceable | `audit_log` written inside `admin_set_role` | pgTAP |

**Keys:**
- The Supabase *anon* key in the frontend is public by design; it only grants what RLS allows.
- The service-role key and the Google OAuth secret are never shipped to the browser.

**Third parties:**
- On-device models: prompts never leave the device.
- Browser speech recognition (Chrome/Edge/Safari) does send audio to the browser vendor. The
  "on-device" voice mode (Whisper) keeps it local, and the app uses it automatically when offline.

**Making the first admin** (once, in the Supabase SQL editor):

```sql
update public.profiles set role = 'admin' where email = 'you@example.com';
```

After that, admins can promote or demote others from the admin console. Every change is logged.
