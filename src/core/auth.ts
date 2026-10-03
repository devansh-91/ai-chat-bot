import type { Session } from '@supabase/supabase-js'
import { GUEST_OWNER } from './config'
import { createStore } from './store'
import { supabase } from './supabase'
import { claimGuestData, SyncEngine, wipeUserData } from './sync'

export type AppRole = 'user' | 'admin'

export interface AuthUser {
  id: string
  email: string | null
  name: string | null
  avatarUrl: string | null
}

export interface AuthState {
  /** disabled = no Supabase configured (offline/guest-only build). */
  status: 'disabled' | 'loading' | 'signedOut' | 'signedIn'
  user: AuthUser | null
  role: AppRole
  /** true once the role was confirmed from the database, not just read from the token. */
  roleVerified: boolean
}

export const authState = createStore<AuthState>({
  status: supabase ? 'loading' : 'disabled',
  user: null,
  role: 'user',
  roleVerified: false,
})

let engine: SyncEngine | null = null

/** Current data owner: the signed-in user's id, or the guest bucket. */
export function currentOwnerId(): string {
  return authState.get().user?.id ?? GUEST_OWNER
}

export function requestSync(): void {
  engine?.request()
}

/** Reads a claim from the (already server-signed) access token. Used for routing only, never for security. */
export function decodeJwtClaims(token: string): Record<string, unknown> {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const json = decodeURIComponent(
      atob(payload)
        .split('')
        .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join(''),
    )
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return {}
  }
}

async function applySession(session: Session | null): Promise<void> {
  const sb = supabase!
  const prev = authState.get().user
  if (!session) {
    engine?.stop()
    engine = null
    authState.set({ status: 'signedOut', user: null, role: 'user', roleVerified: false })
    return
  }
  const u = session.user
  const claims = decodeJwtClaims(session.access_token)
  const user: AuthUser = {
    id: u.id,
    email: u.email ?? null,
    name: (u.user_metadata.full_name as string | undefined) ?? (u.user_metadata.name as string | undefined) ?? null,
    avatarUrl: (u.user_metadata.avatar_url as string | undefined) ?? null,
  }
  const sameUser = prev?.id === user.id
  authState.set((s) => ({
    status: 'signedIn',
    user,
    role: sameUser && s.roleVerified ? s.role : claims.user_role === 'admin' ? 'admin' : 'user',
    roleVerified: sameUser && s.roleVerified,
  }))
  if (!sameUser || !engine) {
    await claimGuestData(GUEST_OWNER, user.id)
    engine?.stop()
    engine = new SyncEngine(sb, user.id)
    engine.start()
  }
  // Confirm role from the database (authoritative; works only online).
  const { data } = await sb.from('profiles').select('role').eq('id', user.id).maybeSingle()
  if (data) authState.set((s) => (s.user?.id === user.id ? { ...s, role: data.role as AppRole, roleVerified: true } : s))
  void sb.from('profiles').update({ last_seen_at: new Date().toISOString() }).eq('id', user.id)
}

export async function initAuth(): Promise<void> {
  if (!supabase) return
  const { data } = await supabase.auth.getSession()
  await applySession(data.session)
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'INITIAL_SESSION') return
    // Supabase recommends not awaiting other supabase calls inside this callback.
    setTimeout(() => void applySession(session), 0)
  })
}

export async function signInWithGoogle(): Promise<void> {
  if (!supabase) throw new Error('Cloud sync is not configured')
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: new URL(import.meta.env.BASE_URL, window.location.origin).href },
  })
  if (error) throw error
}

/** Signs out and removes this account's chats from the device (they stay in the cloud). */
export async function signOut(): Promise<void> {
  if (!supabase) return
  const id = authState.get().user?.id
  engine?.stop()
  engine = null
  await supabase.auth.signOut()
  if (id) await wipeUserData(id)
}
