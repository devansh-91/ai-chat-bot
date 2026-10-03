export const APP_NAME = 'Shreyan.ai'

/** All user data (local and cloud) is purged after this many days. Mirrors public.retention_interval(). */
export const RETENTION_DAYS = 15
export const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000

/** Telemetry HUD target: time-to-first-token budget. */
export const LATENCY_TARGET_MS = 800

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? ''
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? ''

/** Without Supabase credentials the app still works fully offline in guest mode. */
export const CLOUD_ENABLED = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY)

export const DEFAULT_OLLAMA_URL = import.meta.env.VITE_OLLAMA_URL ?? 'http://localhost:11434'

/** Owner id used for data created while signed out. */
export const GUEST_OWNER = 'guest'
