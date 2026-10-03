/**
 * Activity monitor against a real local Supabase: events queued offline are uploaded by the sync
 * engine, admins see them (RPC + realtime), and a non-admin listening on realtime receives nothing.
 * Run: npm run test:integration
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LocalDB } from '../src/core/db'
import { SyncEngine, syncState } from '../src/core/sync'

const URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const ANON = process.env.SUPABASE_ANON_KEY!
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!

Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true })

const stamp = Date.now()
const emails = { user: `user-${stamp}@example.com`, admin: `admin-${stamp}@example.com`, snoop: `snoop-${stamp}@example.com` }
const ids: Record<keyof typeof emails, string> = { user: '', admin: '', snoop: '' }
let service: SupabaseClient

async function signedIn(email: string) {
  const sb = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } })
  const { error } = await sb.auth.signInWithPassword({ email, password: 'password-123' })
  if (error) throw error
  return sb
}

/** Resolves with the realtime rows a client receives on activity_events during `ms`. */
function listen(sb: SupabaseClient, ms: number, ready: () => void): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const got: unknown[] = []
    const ch = sb
      .channel(`t-${crypto.randomUUID()}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activity_events' }, (p) => got.push(p.new))
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          ready()
          setTimeout(() => {
            void sb.removeChannel(ch)
            resolve(got)
          }, ms)
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(new Error(status))
      })
  })
}

beforeAll(async () => {
  service = createClient(URL, SERVICE, { auth: { persistSession: false } })
  for (const k of Object.keys(emails) as (keyof typeof emails)[]) {
    const { data, error } = await service.auth.admin.createUser({ email: emails[k], password: 'password-123', email_confirm: true })
    if (error) throw error
    ids[k] = data.user.id
  }
  await service.from('profiles').update({ role: 'admin' }).eq('id', ids.admin)
})

afterAll(async () => {
  for (const id of Object.values(ids)) if (id) await service.auth.admin.deleteUser(id)
})

describe('admin activity monitor', () => {
  it('admin sees live activity and presence; other users see nothing', async () => {
    const user = await signedIn(emails.user)
    const admin = await signedIn(emails.admin)
    const snoop = await signedIn(emails.snoop)
    // Realtime must use each client's JWT.
    for (const c of [user, admin, snoop]) {
      const { data } = await c.auth.getSession()
      await c.realtime.setAuth(data.session!.access_token)
    }

    // The user's phone queued two events while offline.
    const local = new LocalDB(`it-act-${crypto.randomUUID()}`)
    await local.open()
    await local.activity.bulkAdd([
      { clientId: crypto.randomUUID(), ownerId: ids.user, kind: 'message_sent', meta: { persona: 'tutor', chars: 42 }, deviceKind: 'mobile', createdAt: Date.now() - 5000 },
      { clientId: crypto.randomUUID(), ownerId: ids.user, kind: 'reply', meta: { model: 'qwen', ttft_ms: 420, total_ms: 1500 }, deviceKind: 'mobile', createdAt: Date.now() - 4000 },
    ])

    let readyCount = 0
    let onReady!: () => void
    const bothReady = new Promise<void>((r) => (onReady = r))
    const ready = () => ++readyCount === 2 && onReady()
    const adminGot = listen(admin, 4000, ready)
    const snoopGot = listen(snoop, 4000, ready)
    await bothReady
    await new Promise((r) => setTimeout(r, 500))

    await new SyncEngine(user, ids.user, local).run()
    expect(syncState.get().error ?? syncState.get().phase).toBe('idle')
    expect(await local.activity.count()).toBe(0)

    const { error: pErr } = await user
      .from('user_presence')
      .upsert({ user_id: ids.user, status: 'generating', page: '/c/:id', model: 'qwen', device_kind: 'mobile' }, { onConflict: 'user_id' })
    expect(pErr).toBeNull()

    const [a, s] = await Promise.all([adminGot, snoopGot])
    expect(a.length).toBe(2)
    expect(s.length).toBe(0)

    const { data: live } = await admin.rpc('admin_live_users')
    const me = (live as { user_id: string; status: string; online: boolean }[]).find((u) => u.user_id === ids.user)
    expect(me).toMatchObject({ status: 'generating', online: true })

    const { data: feed } = await admin.rpc('admin_activity_feed', { only_user: ids.user })
    expect((feed as { kind: string }[]).map((e) => e.kind)).toEqual(['reply', 'message_sent'])

    const { error: denied } = await snoop.rpc('admin_activity_feed')
    expect(denied?.code).toBe('42501')
    const { data: peek } = await snoop.from('user_presence').select('*')
    expect(peek).toEqual([])
  }, 60_000)
})
