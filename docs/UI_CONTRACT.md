# UI contract

Everything the app *does* lives behind React hooks in `src/hooks/index.ts`. The current `src/ui/` is a
plain placeholder. Delete or replace any of it; as long as screens use these hooks, models, sync,
voice and security keep working.

## Screens to design

1. **Chat:** tab strip of open chats, history drawer (all chats, "deletes in N days"), message list, composer
   (text, mic, send/stop). Keep the top bar minimal and put details (model, speed, persona, account) behind a toggle.
2. **Model picker / first-run:** pick or download a model, with progress and a device-tier badge.
3. **Telemetry HUD:** a small always-visible widget (TTFT, tokens/sec, p50, % under 800 ms).
4. **Settings:** voice (voice list, pitch, rate, auto-read, test), Ollama URL, privacy info.
5. **Admin console:** overview cards, **live activity monitor** (who's online and what they're doing, plus a live
   event feed), latency by model, latency timeline (chart), users with promote/demote, audit log, "run purge now".
6. **Sign-in:** a "Continue with Google" button. Guest mode works without it.
7. **Status chrome:** online/offline, sync state, pending changes, "auto-deletes in N days" on each chat.

Design for **phone first**: the same app is installed on phones.

## Hooks

### `useAuth()`
| field | type | notes |
|---|---|---|
| `status` | `'disabled' \| 'loading' \| 'signedOut' \| 'signedIn'` | `disabled` = build without Supabase (guest-only) |
| `user` | `{ id, email, name, avatarUrl } \| null` | from Google |
| `isAdmin` | `boolean` | show admin entry points only when true |
| `roleVerified` | `boolean` | role confirmed by the database (vs. read from the token) |
| `signInWithGoogle()` / `signOut()` | `Promise<void>` | sign-out also clears this account's chats from the device |

### `useConversations()`
`conversations[]` (`{ id, title, persona, createdAt, updatedAt }`, newest first), `loading`,
`create(persona?) → id`, `rename(id, title)`, `remove(id)`, `setPersona(id, persona)`,
`expiresIn(conversation) → ms`.

### `useChat(conversationId)`
| field | notes |
|---|---|
| `conversation`, `messages[]` | messages: `{ id, role, content, model, createdAt, metrics? }` |
| `streamingText` | assistant text so far while generating (`undefined` otherwise). Render as an in-progress bubble. |
| `isGenerating`, `error` | |
| `send(text)`, `stop()` | if auto-read is on, `send` speaks the reply as it streams |

| `canRetry`, `retry()` | the last message is the user's with no reply (model failed to load, error, app closed mid-reply): show a "Try again" button |

The user's message is added (and visible) **immediately** on `send`. If no model is loaded, the default one loads
first: show `useModel().progress` while `isGenerating && model.status === 'loading'`.

`metrics` on assistant messages: `{ provider, model, ttftMs, totalMs, outputTokens, tokensPerSec }`.

### `useModel()`
`status` (`idle | loading | ready | error`), `spec` (current model), `progress` (`{ fraction 0..1 | null, text }`),
`error`, `device` (`{ tier, webgpu, mobile, … }`), `available[]` (specs this device can run, plus detected Ollama models),
`recommendedKey`, `lastUsedKey`, `load(key)`, `refreshOllama()`.

Each spec has `{ key, label, provider, downloadMB, contextTokens }`. On a first visit, show a "download
the recommended model (~1 GB, once)" step, since phones may be on mobile data.

### `useTabs()`
Open chats as tabs, remembered on the device per account (survive reloads; a tab disappears when its chat is
deleted or auto-purged after 15 days; closing a tab only hides it, the chat stays in history).
`tabs[]` (conversations, in tab order), `activeId`, `open(id)`, `close(id) → { open, active }` (navigate to the
returned `active`), `newTab(persona?) → id`. Max 12 tabs; the oldest drop off.

### `useTelemetryHud()`
`last` (most recent turn), `samples[]` (up to 100), `stats` (`ttftP50`, `ttftP95`, `totalP50`,
`avgTokensPerSec`, `underTargetRatio`, `count`, `errors`), `targetMs` (800).
Colour suggestion: TTFT < 800 good, ≥ 800 warning, null (error) bad.

### `useVoice()`
`settings` (`voiceURI`, `pitch`, `rate`, `autoSpeak`), `updateSettings(patch)`, `voices[]`, `autoVoice`,
`isSpeaking`, `speak(text)`, `stopSpeaking()`,
`dictation` (`listening`, `transcribing`, `interim`, `engine: 'browser' | 'on-device'`, `modelProgress`, `error`),
`startDictation(mode?, lang?)`, `stopDictation() → text`, `cancelDictation()`.

On-device dictation transcribes after the user stops talking, so show a "transcribing…" state.

### `useOnline()`, `useSyncStatus()`
`useSyncStatus()`: `phase` (`disabled | offline | syncing | idle | error`), `realtime` (live connection),
`pending` (unsynced changes), `lastSyncAt`, `error`.

### `useAdmin(windowHours = 24)`
Each of `overview`, `byModel`, `series`, `users`, `audit` is `{ data, error, loading, reload }`.
- `overview.data`: `users, admins, active_24h, conversations, messages, next_purge_cutoff, last_purge`
- `byModel.data[]`: `model, provider, requests, errors, ttft_p50, ttft_p95, total_p50, total_p95, avg_tokens_per_sec, sub_800ms_ratio`
- `series.data[]`: `bucket` (ISO time), `requests, ttft_p50, ttft_p95, active_users`, good for a line chart
- `users.data[]`: `id, email, display_name, avatar_url, role, created_at, last_seen_at, requests_24h`
- `audit.data[]`: `action, target, meta, created_at`
- actions: `setRole(userId, 'user' | 'admin')`, `runPurge()`

Telemetry refreshes every 10 s. Non-admins get `error: 'Admin access required'`.

### `useLiveActivity({ windowHours?, userId?, kind?, maxEvents? })` (admin)
Who's on Shreyan.ai right now and what they're doing, updated in real time. **Metadata only, never message text.**

| field | notes |
|---|---|
| `users[]` | online first: `user_id, display_name, email, avatar_url, role, online, status, page, model, device_kind, device_tier, updated_at, last_event, last_event_at, events_1h` |
| `online[]` | subset of `users` that are online now |
| `status` values | `generating` (AI is replying), `listening` (mic on), `typing`, `active`, `idle` (app in background), `offline` |
| `feed[]` | newest first: `id, user_id, display_name, email, kind, meta, device_kind, created_at`. Use `describeActivity(e.kind, e.meta)` for a readable line, e.g. "got a reply from Qwen2.5… in 1.4 s (first token 320 ms)" |
| `stats` | `online_now, active_users, by_kind{}, by_device{}, top_models[], top_personas[]` |
| `live` | realtime connection is up (show a pulsing "LIVE" dot) |
| `error`, `reload()` | |

Pass `userId` to drill into one person, or `kind` (e.g. `'reply_error'`) to filter the feed.
Event kinds: `session_start, sign_in, sign_out, chat_created, chat_deleted, persona_changed, message_sent, reply,
reply_error, reply_stopped, model_loaded, model_error, voice_input, voice_output, page_view`.

### Reporting (call these from your UI)
- `usePageReporting(location.pathname)`: once, in the root component (already wired in the placeholder).
- `reportTyping()`: in the composer's `onChange`, so admins see "typing" (the text is never sent).

Everything else (generating, listening, model, device, events) is reported automatically.

### Constants
`PERSONAS` (`{ id, label, description }[]`), `RETENTION_DAYS` (15), `LATENCY_TARGET_MS` (800), `CLOUD_ENABLED`, `describeActivity`.

## Routes (current placeholder)
`/` → latest chat · `/c/:id` · `/settings` · `/admin` (guarded; data is protected server-side anyway)
