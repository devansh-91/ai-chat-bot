import type { AppRole } from './auth'
import { supabase } from './supabase'

/**
 * Admin console API. Every call is an RPC that re-checks the caller's role inside Postgres,
 * so a non-admin gets a 42501 error no matter what the UI shows.
 */

export interface AdminOverview {
  users: number
  admins: number
  active_24h: number
  conversations: number
  messages: number
  oldest_message: string | null
  next_purge_cutoff: string
  last_purge: { created_at: string; meta: Record<string, number | string> } | null
}

export interface ModelLatencyRow {
  model: string
  provider: string
  requests: number
  errors: number
  ttft_p50: number | null
  ttft_p95: number | null
  total_p50: number | null
  total_p95: number | null
  avg_tokens_per_sec: number | null
  sub_800ms_ratio: number | null
}

export interface LatencyBucket {
  bucket: string
  requests: number
  ttft_p50: number | null
  ttft_p95: number | null
  active_users: number
}

export interface AdminUser {
  id: string
  email: string | null
  display_name: string | null
  avatar_url: string | null
  role: AppRole
  created_at: string
  last_seen_at: string | null
  requests_24h: number
}

export interface AuditEntry {
  id: number
  actor_id: string | null
  action: string
  target: string | null
  meta: Record<string, unknown>
  created_at: string
}

export interface LiveUser {
  user_id: string
  email: string | null
  display_name: string | null
  avatar_url: string | null
  role: AppRole
  /** active | idle | typing | generating | listening | offline */
  status: string
  page: string | null
  model: string | null
  device_kind: 'mobile' | 'desktop' | null
  device_tier: string | null
  updated_at: string | null
  online: boolean
  events_1h: number
  last_event: string | null
  last_event_at: string | null
}

export interface ActivityEvent {
  id: number
  user_id: string
  email: string | null
  display_name: string | null
  avatar_url: string | null
  kind: string
  meta: Record<string, unknown>
  device_kind: 'mobile' | 'desktop' | null
  created_at: string
}

export interface ActivityStats {
  online_now: number
  active_users: number
  by_kind: Record<string, number>
  by_device: Record<string, number>
  top_models: { model: string; replies: number }[]
  top_personas: { persona: string; messages: number }[]
}

export interface ActivityFilter {
  since: Date
  userId?: string | null
  kind?: string | null
  limit?: number
}

function client() {
  if (!supabase) throw new Error('Cloud is not configured')
  return supabase
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await client().rpc(fn, args)
  if (error) throw new Error(error.code === '42501' ? 'Admin access required' : error.message)
  return data as T
}

export const adminApi = {
  overview: () => rpc<AdminOverview>('admin_overview'),
  latencyByModel: (since: Date) => rpc<ModelLatencyRow[]>('admin_telemetry_summary', { since: since.toISOString() }),
  latencySeries: (since: Date, bucketMinutes: number) =>
    rpc<LatencyBucket[]>('admin_telemetry_timeseries', { since: since.toISOString(), bucket_minutes: bucketMinutes }),
  users: () => rpc<AdminUser[]>('admin_list_users'),
  setRole: (userId: string, role: AppRole) => rpc<void>('admin_set_role', { target: userId, new_role: role }),
  runPurge: () => rpc<Record<string, number | string>>('admin_run_purge'),
  liveUsers: () => rpc<LiveUser[]>('admin_live_users'),
  activityFeed: (f: ActivityFilter) =>
    rpc<ActivityEvent[]>('admin_activity_feed', {
      since: f.since.toISOString(),
      max_rows: f.limit ?? 200,
      only_user: f.userId ?? null,
      only_kind: f.kind ?? null,
    }),
  activityStats: (since: Date) => rpc<ActivityStats>('admin_activity_stats', { since: since.toISOString() }),
  async audit(limit = 100): Promise<AuditEntry[]> {
    const { data, error } = await client().from('audit_log').select('*').order('created_at', { ascending: false }).limit(limit)
    if (error) throw error
    return data as AuditEntry[]
  },
}

/** Seconds without a heartbeat before a user counts as offline. Mirrors public.presence_timeout(). */
export const PRESENCE_TIMEOUT_MS = 75_000

interface PresenceRow {
  user_id: string
  status: string
  page: string | null
  model: string | null
  device_kind: 'mobile' | 'desktop' | null
  device_tier: string | null
  updated_at: string
}

interface ActivityRow {
  id: number
  user_id: string
  kind: string
  meta: Record<string, unknown>
  device_kind: 'mobile' | 'desktop' | null
  created_at: string
}

/**
 * Live stream of activity and presence changes. Postgres only delivers these rows to subscribers
 * whose RLS select policy passes, so non-admins receive nothing even if they subscribe.
 */
export function subscribeActivity(handlers: {
  onEvent: (row: ActivityRow) => void
  onPresence: (row: PresenceRow) => void
  onStatus?: (live: boolean) => void
}): () => void {
  const sb = client()
  const channel = sb
    .channel(`admin-activity-${crypto.randomUUID()}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activity_events' }, (p) =>
      handlers.onEvent(p.new as ActivityRow),
    )
    .on('postgres_changes', { event: '*', schema: 'public', table: 'user_presence' }, (p) => {
      if (p.new && 'user_id' in p.new) handlers.onPresence(p.new as PresenceRow)
    })
    .subscribe((status) => handlers.onStatus?.(status === 'SUBSCRIBED'))
  return () => void sb.removeChannel(channel)
}

/** Applies a realtime presence row to the live-user list (pure; unit tested). */
export function applyPresence(users: LiveUser[], row: PresenceRow, now = Date.now()): LiveUser[] {
  return users.map((u) => {
    if (u.user_id !== row.user_id) return u
    const fresh = now - Date.parse(row.updated_at) < PRESENCE_TIMEOUT_MS
    const online = fresh && row.status !== 'offline'
    return { ...u, ...row, status: online ? row.status : 'offline', online }
  })
}

/** Marks users whose heartbeat went stale as offline (pure; unit tested). */
export function expirePresence(users: LiveUser[], now = Date.now()): LiveUser[] {
  return users.map((u) =>
    u.online && u.updated_at && now - Date.parse(u.updated_at) >= PRESENCE_TIMEOUT_MS ? { ...u, online: false, status: 'offline' } : u,
  )
}

/** Online first, then most recently seen. */
export function sortLiveUsers(users: LiveUser[]): LiveUser[] {
  const seen = (u: LiveUser) => Date.parse(u.updated_at ?? u.last_event_at ?? '') || 0
  return [...users].sort((a, b) => Number(b.online) - Number(a.online) || seen(b) - seen(a))
}
