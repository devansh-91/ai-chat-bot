# Shreyan.ai: Autonomous Conversational AI & Telemetry Engine

> IEEE Exhibition · Software & AI track · Shreyansh Mishra (B.Tech CSE, 1st year), Amity University Lucknow

A private AI assistant that **runs the language model on your own device**: phone or PC, online or offline.
Sign in with Google and your chats **sync live between devices**. Admins get a **live latency dashboard**, and
everything is **automatically deleted after 15 days**.

Costs nothing to run: no paid APIs and no servers to rent.

## Highlights

| Poster claim | How it's built |
|---|---|
| **Calibrated masculine voice (Web Speech API)** | Ranks the device's voices (male → your language → works offline), pitch tuned to 0.85, speaks sentence by sentence *while* the reply streams. Voice input: browser speech recognition online, **Whisper running on-device** offline. |
| **Role-based access control (cryptographic admin route)** | Google sign-in through Supabase. The role is **signed into the JWT** (`user_role` claim) by a Postgres hook, and every admin action is re-checked inside Postgres (row-level security plus `security definer` functions), so a hand-edited token or frontend can't get in. Database tests prove it. |
| **Live telemetry HUD (<800 ms)** | Every reply records time to first token, total latency and tokens/sec, shown live in the HUD and aggregated (p50/p95, share under 800 ms) in the admin console. Measured on a laptop: **TTFT 34–42 ms, ~53 tok/s** (Ollama, Llama 3.2 3B). |
| **15-day auto-purge** | Server: `pg_cron` runs `purge_expired()` every hour. Device: the same rule runs on the local IndexedDB. Deleting a chat wipes its content immediately and syncs to all devices. |

Also:
- **Admin live activity monitor.** See who's online and what they're doing (typing, generating, using the mic,
  which model and device) with a real-time event feed. Metadata only: admins never see message text.
- **Works offline after first load.** Installable app; chats live in IndexedDB.
- **Cross-device sync.** Realtime updates, plus a catch-up sync that copes with offline edits.
- **Automatic model tiering.** Detects the device's capabilities and picks the right model (below).
- Personas (Tutor, Coder, Concise, Hindi/Hinglish).

## Model tiers (all free)

| Device | Runtime | Default model | Download (once) |
|---|---|---|---|
| Laptop/desktop with WebGPU | WebLLM | Qwen2.5-1.5B-Instruct (q4f16) | ~1 GB |
| Modern phone with WebGPU (Android Chrome, iOS 26 Safari) | WebLLM | Qwen2.5-1.5B (or 0.5B on low memory) | 0.4–1 GB |
| Any browser without WebGPU | wllama (llama.cpp in WASM) | Qwen2.5-0.5B GGUF Q4_K_M | ~0.4 GB |
| Demo laptop | Ollama (local server) | whatever is installed, e.g. `llama3.2:3b` | — |

## Quick start

```bash
npm install
npm run dev                # offline guest mode works with no configuration
```

With sign-in and sync (local Supabase in Docker):

```bash
npm run db:start           # prints API_URL and ANON_KEY
cp .env.example .env.local # fill VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
npm run dev
```

Setting up the hosted version (Supabase cloud, Google OAuth, GitHub Pages): see [docs/SETUP.md](docs/SETUP.md).

## Tests

```bash
npm test                   # unit: sync merges, purge, tiering, voice, telemetry math
npm run test:db            # pgTAP: RLS, role escalation, forged JWT, activity privacy, purge (44 assertions)
npm run test:integration   # two-device sync + admin realtime activity feed through a real Supabase
```

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [UI contract](docs/UI_CONTRACT.md): the hooks the UI is built on
- [Security model](docs/SECURITY.md)
- [Setup & deployment](docs/SETUP.md)

## Project layout

```
src/core/        all behavior: models, sync, auth, telemetry, voice, privacy (no UI)
src/hooks/       the public API for screens (React hooks)
src/ui/          placeholder UI, to be replaced by the final design
supabase/        migrations (schema + RLS + cron) and pgTAP tests
tests/           integration tests
```

License: MIT
