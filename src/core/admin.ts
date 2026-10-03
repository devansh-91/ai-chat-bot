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
  async audit(limit = 100): Promise<AuditEntry[]> {
    const { data, error } = await client().from('audit_log').select('*').order('created_at', { ascending: false }).limit(limit)
    if (error) throw error
    return data as AuditEntry[]
  },
}
