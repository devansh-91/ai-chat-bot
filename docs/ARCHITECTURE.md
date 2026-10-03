# Architecture

```
                ┌──────────────────────── Browser (phone / PC) ─────────────────────────┐
                │  React UI (src/ui)  ──uses──▶  hooks (src/hooks)                      │
                │                                   │                                   │
                │   ┌───────────────┬───────────────┼──────────────┬────────────────┐   │
                │   ▼               ▼               ▼              ▼                ▼   │
                │ LLM engine     chat service    sync engine     telemetry        voice │
                │  │ WebLLM worker (WebGPU)       │ IndexedDB      │ HUD ring buffer TTS │
                │  │ wllama (WASM CPU)            │ (Dexie)        │ local queue     STT │
                │  │ Ollama (localhost)           │                │                 └ Whisper worker
                │  ▼                              ▼                ▼                     │
                │ model weights cached     dirty rows ──push──▶ ◀──pull/realtime──       │
                └─────────────────────────────────────┼──────────────────────────────────┘
                                                      │ HTTPS (anon key + user JWT)
                ┌─────────────────────────── Supabase (free tier) ────────────────────────┐
                │ Auth (Google OAuth) ── custom_access_token_hook → JWT { user_role }     │
                │ Postgres: profiles · conversations · messages · telemetry_events ·      │
                │           audit_log   (RLS on every table)                              │
                │ admin_* RPCs (security definer + is_admin() gate)                        │
                │ pg_cron: purge_expired() hourly (15-day retention)                       │
                │ Realtime: postgres_changes on conversations/messages (RLS-filtered)      │
                └──────────────────────────────────────────────────────────────────────────┘
```

## Key decisions

**Inference on the device, not on a server.** There's no GPU bill, the app works offline, and prompts never
leave the device. The trade-off is a one-time model download and a smaller model. Tiering (`src/core/llm/device.ts`)
picks the largest model the device can run.

**Offline-first data.** Every write goes to IndexedDB first, marked `dirty`. The sync engine (`src/core/sync.ts`):

- **push:** conversations are upserted, with the last write winning. Messages are immutable
  (`insert … on conflict do nothing`), so retrying a push is always safe.
- **pull:** pages through results ordered by `server_updated_at`, which the server clock sets.
  Rows written offline on another device still arrive even when that device's clock is wrong.
  Pages are ordered by `(server_updated_at, id)` so rows sharing a timestamp aren't skipped.
- **Deletion can't be undone.** A conversation is soft-deleted: a trigger wipes its messages, and a deleted
  row can never be revived, not even by a stale device pushing an old copy.
- **realtime:** while online, other devices see changes within about 100 ms. When the connection comes
  back, a catch-up sync fills any gap.

**Security lives in Postgres.** The frontend only hides admin UI. All checks happen in RLS and
`security definer` functions. See [SECURITY.md](SECURITY.md).

**Telemetry.**
- TTFT is measured from the request to the first streamed token.
- Tokens/sec covers only the generation after the first token.
- Each turn goes to a ring buffer (live HUD) and a local queue, which is uploaded on sync with a
  per-event id so retries never double-count.
- Admin aggregates use `percentile_cont`; the client uses the same calculation, so the HUD and
  the dashboard agree.

**15-day lifecycle.**
- Server: `pg_cron` runs `purge_expired()` hourly.
- Device: `purgeLocal()` runs on startup and hourly.
- Client timestamps are clamped to the server clock, so forged future dates can't escape the purge.
