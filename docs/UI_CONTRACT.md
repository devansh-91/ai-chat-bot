# UI contract

Everything the app *does* lives behind React hooks in `src/hooks/index.ts`. The current `src/ui/` is a
plain placeholder. Delete or replace any of it; as long as screens use these hooks, models, sync,
voice and security keep working.

## Screens to design

1. **Chat:** sidebar of conversations, message list, composer (text, mic, send/stop), persona switch.
2. **Model picker / first-run:** pick or download a model, with progress and a device-tier badge.
3. **Telemetry HUD:** a small always-visible widget (TTFT, tokens/sec, p50, % under 800 ms).
4. **Settings:** voice (voice list, pitch, rate, auto-read, test), Ollama URL, privacy info.
5. **Admin console:** overview cards, latency by model, latency timeline (chart), users with
   promote/demote, audit log, "run purge now".
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

`metrics` on assistant messages: `{ provider, model, ttftMs, totalMs, outputTokens, tokensPerSec }`.

### `useModel()`
`status` (`idle | loading | ready | error`), `spec` (current model), `progress` (`{ fraction 0..1 | null, text }`),
`error`, `device` (`{ tier, webgpu, mobile, … }`), `available[]` (specs this device can run, plus detected Ollama models),
`recommendedKey`, `lastUsedKey`, `load(key)`, `refreshOllama()`.

Each spec has `{ key, label, provider, downloadMB, contextTokens }`. On a first visit, show a "download
the recommended model (~1 GB, once)" step, since phones may be on mobile data.

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

### Constants
`PERSONAS` (`{ id, label, description }[]`), `RETENTION_DAYS` (15), `LATENCY_TARGET_MS` (800), `CLOUD_ENABLED`.

## Routes (current placeholder)
`/` → latest chat · `/c/:id` · `/settings` · `/admin` (guarded; data is protected server-side anyway)
