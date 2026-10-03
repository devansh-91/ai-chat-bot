/**
 * Runs the real sync engine against a local Supabase (npx supabase start).
 * Two "devices" = two independent IndexedDB databases + two signed-in clients for one user.
 * Run: npm run test:integration
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const ANON = process.env.SUPABASE_ANON_KEY!
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!

import { LocalDB } from '../src/core/db'
import { SyncEngine, syncState } from '../src/core/sync'

// Node's navigator has no onLine; the engine skips syncing when offline.
Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true })

let admin: SupabaseClient
let userId: string
const email = `it-${Date.now()}@example.com`

async function device(name: string) {
  const sb = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } })
  const { error } = await sb.auth.signInWithPassword({ email, password: 'password-123' })
  if (error) throw error
  const local = new LocalDB(`it-${name}-${crypto.randomUUID()}`)
  await local.open()
  return { sb, local }
}

async function syncOn(d: Awaited<ReturnType<typeof device>>) {
  await new SyncEngine(d.sb, userId, d.local).run()
  const s = syncState.get()
  if (s.phase !== 'idle') throw new Error(`sync ${s.phase}: ${s.error}`)
}

beforeAll(async () => {
  admin = createClient(URL, SERVICE, { auth: { persistSession: false } })
  const { data, error } = await admin.auth.admin.createUser({ email, password: 'password-123', email_confirm: true })
  if (error) throw error
  userId = data.user.id
})

afterAll(async () => {
  if (userId) await admin.auth.admin.deleteUser(userId)
})

describe('two-device sync', () => {
  it('phone writes offline, laptop receives after sync; deletion propagates', async () => {
    const phone = await device('phone')
    const laptop = await device('laptop')
    const now = Date.now()

    await phone.local.conversations.add({ id: crypto.randomUUID(), ownerId: userId, title: 'From phone', persona: 'tutor', createdAt: now, updatedAt: now, deletedAt: null, dirty: 1 })
    const conv = (await phone.local.conversations.toArray())[0]
    // 600 messages > one page, all pushed in the same transaction timestamp: exercises keyset paging ties.
    await phone.local.messages.bulkAdd(
      Array.from({ length: 600 }, (_, i) => ({
        id: crypto.randomUUID(), conversationId: conv.id, ownerId: userId, role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
        content: `msg ${i}`, model: null, createdAt: now + i, dirty: 1 as const,
      })),
    )
    await phone.local.telemetry.add({ clientId: crypto.randomUUID(), ownerId: userId, provider: 'webllm', model: 'q', ttftMs: 400, totalMs: 900, outputTokens: 20, tokensPerSec: 25, deviceTier: 'mid', deviceKind: 'mobile', wasOnline: false, error: null, createdAt: now })

    await syncOn(phone)
    expect(await phone.local.messages.where('dirty').equals(1).count()).toBe(0)
    expect(await phone.local.telemetry.count()).toBe(0)

    await syncOn(laptop)
    expect((await laptop.local.conversations.get(conv.id))?.title).toBe('From phone')
    expect(await laptop.local.messages.count()).toBe(600)

    // Pushing again is idempotent
    await phone.local.messages.toCollection().modify({ dirty: 1 })
    await syncOn(phone)
    const { count } = await phone.sb.from('messages').select('*', { count: 'exact', head: true })
    expect(count).toBe(600)

    // Laptop renames, phone receives
    await laptop.local.conversations.update(conv.id, { title: 'Renamed on laptop', updatedAt: Date.now() + 1000, dirty: 1 })
    await syncOn(laptop)
    await syncOn(phone)
    expect((await phone.local.conversations.get(conv.id))?.title).toBe('Renamed on laptop')

    // Phone deletes, laptop's copy is wiped
    await phone.local.messages.where('conversationId').equals(conv.id).delete()
    await phone.local.conversations.update(conv.id, { deletedAt: Date.now(), title: null, updatedAt: Date.now() + 2000, dirty: 1 })
    await syncOn(phone)
    await syncOn(laptop)
    expect((await laptop.local.conversations.get(conv.id))?.deletedAt).not.toBeNull()
    expect(await laptop.local.messages.count()).toBe(0)

    // A stale laptop write cannot resurrect it on the server
    await laptop.local.conversations.update(conv.id, { deletedAt: null, title: 'zombie', dirty: 1 })
    await syncOn(laptop)
    const { data } = await laptop.sb.from('conversations').select('deleted_at,title').eq('id', conv.id).single()
    expect(data?.deleted_at).not.toBeNull()
    expect(data?.title).toBeNull()
  }, 60_000)
})
