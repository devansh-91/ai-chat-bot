import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import { db, type LocalConversation, type LocalDB, type LocalMessage } from './db'
import { createStore } from './store'

/**
 * Offline-first sync between this device's IndexedDB and Supabase.
 *
 *  - Every write lands locally first with dirty=1, so the app works with no network.
 *  - push(): dirty rows are upserted. Messages are immutable (insert-or-ignore), conversations are
 *    last-write-wins on updated_at, and deletion is sticky (a tombstone can never be undone).
 *  - pull(): keyset-paginated on the server-clock column server_updated_at, so rows created offline
 *    on another device are still picked up. A small overlap window + idempotent merges make
 *    re-reads harmless.
 *  - Realtime: postgres_changes pushes edits from other devices within ~100ms while online.
 */

export interface ConversationRow {
  id: string
  user_id: string
  title: string | null
  persona: string
  created_at: string
  updated_at: string
  deleted_at: string | null
  server_updated_at: string
}

export interface MessageRow {
  id: string
  conversation_id: string
  user_id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  model: string | null
  created_at: string
  server_updated_at: string
}

export type SyncPhase = 'disabled' | 'offline' | 'syncing' | 'idle' | 'error'

export interface SyncState {
  phase: SyncPhase
  lastSyncAt: number | null
  error: string | null
  realtime: boolean
}

export const syncState = createStore<SyncState>({ phase: 'disabled', lastSyncAt: null, error: null, realtime: false })

const ts = (iso: string | null) => (iso ? Date.parse(iso) : null)
const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString())

const OVERLAP_MS = 10_000
const PAGE = 500

// ───────────────────────── merges (pure DB logic, unit tested) ─────────────────────────

export async function mergeConversation(row: ConversationRow, database: LocalDB = db): Promise<void> {
  await database.transaction('rw', database.conversations, database.messages, async () => {
    const local = await database.conversations.get(row.id)
    if (row.deleted_at) {
      await database.messages.where('conversationId').equals(row.id).delete()
      await database.conversations.put({
        id: row.id,
        ownerId: row.user_id,
        title: null,
        persona: row.persona,
        createdAt: ts(row.created_at)!,
        updatedAt: ts(row.updated_at)!,
        deletedAt: ts(row.deleted_at),
        dirty: 0,
      })
      return
    }
    if (local?.deletedAt) return // deleted here; tombstone will be pushed
    if (local?.dirty && local.updatedAt > ts(row.updated_at)!) return // local edit is newer
    await database.conversations.put({
      id: row.id,
      ownerId: row.user_id,
      title: row.title,
      persona: row.persona,
      createdAt: ts(row.created_at)!,
      updatedAt: ts(row.updated_at)!,
      deletedAt: null,
      dirty: 0,
    })
  })
}

export async function mergeMessage(row: MessageRow, database: LocalDB = db): Promise<void> {
  await database.transaction('rw', database.conversations, database.messages, async () => {
    const conv = await database.conversations.get(row.conversation_id)
    if (conv?.deletedAt) return
    const local = await database.messages.get(row.id)
    if (local) {
      if (local.dirty) await database.messages.update(row.id, { dirty: 0 })
      return
    }
    await database.messages.put({
      id: row.id,
      conversationId: row.conversation_id,
      ownerId: row.user_id,
      role: row.role,
      content: row.content,
      model: row.model,
      createdAt: ts(row.created_at)!,
      dirty: 0,
    })
  })
}

export function conversationToRow(c: LocalConversation) {
  return {
    id: c.id,
    user_id: c.ownerId,
    title: c.title,
    persona: c.persona,
    created_at: iso(c.createdAt),
    updated_at: iso(c.updatedAt),
    deleted_at: iso(c.deletedAt),
  }
}

export function messageToRow(m: LocalMessage) {
  return {
    id: m.id,
    conversation_id: m.conversationId,
    user_id: m.ownerId,
    role: m.role,
    content: m.content,
    model: m.model,
    created_at: iso(m.createdAt),
  }
}

/** Moves data created while signed out to the signed-in account so it syncs. */
export async function claimGuestData(guestId: string, userId: string, database: LocalDB = db): Promise<void> {
  await database.transaction('rw', database.conversations, database.messages, database.telemetry, async () => {
    await database.conversations.where('ownerId').equals(guestId).modify({ ownerId: userId, dirty: 1 })
    await database.messages.where('ownerId').equals(guestId).modify({ ownerId: userId, dirty: 1 })
    await database.telemetry.where('ownerId').equals(guestId).modify({ ownerId: userId })
  })
}

/** Removes a signed-out user's data from this device (shared-device privacy). */
export async function wipeUserData(userId: string, database: LocalDB = db): Promise<void> {
  await database.transaction('rw', [database.conversations, database.messages, database.telemetry, database.kv], async () => {
    await database.conversations.where('ownerId').equals(userId).delete()
    await database.messages.where('ownerId').equals(userId).delete()
    await database.telemetry.where('ownerId').equals(userId).delete()
    await database.kv.delete(`cursor:conversations:${userId}`)
    await database.kv.delete(`cursor:messages:${userId}`)
  })
}

// ───────────────────────── engine ─────────────────────────

interface Cursor {
  ts: string
  id: string
}

export class SyncEngine {
  private channel: RealtimeChannel | null = null
  private running: Promise<void> | null = null
  private again = false
  private debounce: ReturnType<typeof setTimeout> | null = null
  private interval: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private readonly sb: SupabaseClient
  private readonly userId: string
  private readonly db: LocalDB

  constructor(sb: SupabaseClient, userId: string, database: LocalDB = db) {
    this.sb = sb
    this.userId = userId
    this.db = database
  }

  start(): void {
    window.addEventListener('online', this.onOnline)
    window.addEventListener('offline', this.onOffline)
    document.addEventListener('visibilitychange', this.onVisible)
    this.interval = setInterval(() => this.request(0), 60_000)
    this.subscribe()
    this.request(0)
  }

  stop(): void {
    this.stopped = true
    window.removeEventListener('online', this.onOnline)
    window.removeEventListener('offline', this.onOffline)
    document.removeEventListener('visibilitychange', this.onVisible)
    if (this.interval) clearInterval(this.interval)
    if (this.debounce) clearTimeout(this.debounce)
    if (this.channel) void this.sb.removeChannel(this.channel)
    this.channel = null
    syncState.set({ phase: 'disabled', lastSyncAt: null, error: null, realtime: false })
  }

  /** Schedule a sync soon (coalesces bursts of local writes). */
  request(delayMs = 400): void {
    if (this.stopped) return
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => void this.run(), delayMs)
  }

  private onOnline = () => this.request(0)
  private onOffline = () => syncState.set((s) => ({ ...s, phase: 'offline' }))
  private onVisible = () => {
    if (document.visibilityState === 'visible') this.request(0)
  }

  private subscribe(): void {
    const filter = `user_id=eq.${this.userId}`
    this.channel = this.sb
      .channel(`sync:${this.userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations', filter }, (p) => {
        if (p.new && 'id' in p.new) void mergeConversation(p.new as ConversationRow, this.db)
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter }, (p) => {
        void mergeMessage(p.new as MessageRow, this.db)
      })
      .subscribe((status) => {
        const live = status === 'SUBSCRIBED'
        syncState.set((s) => ({ ...s, realtime: live }))
        if (live) this.request(0) // catch up on anything missed while disconnected
      })
  }

  /** Runs one full pull + push cycle now. */
  async run(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    if (!navigator.onLine) {
      syncState.set((s) => ({ ...s, phase: 'offline' }))
      return
    }
    this.running = (async () => {
      syncState.set((s) => ({ ...s, phase: 'syncing', error: null }))
      try {
        await this.pull('conversations')
        await this.pull('messages')
        await this.push()
        syncState.set((s) => ({ ...s, phase: 'idle', lastSyncAt: Date.now() }))
      } catch (e) {
        syncState.set((s) => ({ ...s, phase: navigator.onLine ? 'error' : 'offline', error: errorMessage(e) }))
      }
    })()
    try {
      await this.running
    } finally {
      this.running = null
      if (this.again && !this.stopped) {
        this.again = false
        this.request(0)
      }
    }
  }

  private async pull(table: 'conversations' | 'messages'): Promise<void> {
    const key = `cursor:${table}:${this.userId}`
    const saved = (await this.db.kv.get(key))?.value as Cursor | undefined
    const since = saved ? new Date(Date.parse(saved.ts) - OVERLAP_MS).toISOString() : '1970-01-01T00:00:00Z'
    let after: Cursor | null = null
    let newest = saved ?? null
    for (;;) {
      let q = this.sb.from(table).select('*').eq('user_id', this.userId)
      q = after
        ? q.or(`server_updated_at.gt."${after.ts}",and(server_updated_at.eq."${after.ts}",id.gt.${after.id})`)
        : q.gte('server_updated_at', since)
      const { data, error } = await q.order('server_updated_at').order('id').limit(PAGE)
      if (error) throw error
      for (const row of data) {
        if (table === 'conversations') await mergeConversation(row as ConversationRow, this.db)
        else await mergeMessage(row as MessageRow, this.db)
      }
      if (data.length) {
        const last = data[data.length - 1] as { server_updated_at: string; id: string }
        after = { ts: last.server_updated_at, id: last.id }
        if (!newest || Date.parse(after.ts) >= Date.parse(newest.ts)) newest = after
      }
      if (data.length < PAGE) break
    }
    if (newest) await this.db.kv.put({ key, value: newest })
  }

  private async push(): Promise<void> {
    const convs = await this.db.conversations.where({ ownerId: this.userId, dirty: 1 }).toArray()
    if (convs.length) {
      const { error } = await this.sb.from('conversations').upsert(convs.map(conversationToRow))
      if (error) throw error
      for (const c of convs) {
        // Only clear the flag if nothing changed locally while the request was in flight.
        await this.db.conversations.where('id').equals(c.id).and((x) => x.updatedAt === c.updatedAt).modify({ dirty: 0 })
      }
    }

    const msgs = await this.db.messages.where({ ownerId: this.userId, dirty: 1 }).toArray()
    for (let i = 0; i < msgs.length; i += 200) {
      const batch = msgs.slice(i, i + 200)
      const { error } = await this.sb
        .from('messages')
        .upsert(batch.map(messageToRow), { onConflict: 'id', ignoreDuplicates: true })
      if (!error) {
        await this.db.messages.bulkUpdate(batch.map((m) => ({ key: m.id, changes: { dirty: 0 as const } })))
        continue
      }
      if (error.code !== '42501') throw error
      // A row was rejected by RLS (its conversation was deleted on another device): retry one by one, drop rejects.
      for (const m of batch) {
        const r = await this.sb.from('messages').upsert(messageToRow(m), { onConflict: 'id', ignoreDuplicates: true })
        if (!r.error) await this.db.messages.update(m.id, { dirty: 0 })
        else if (r.error.code === '42501') await this.db.messages.delete(m.id)
        else throw r.error
      }
    }

    const tel = await this.db.telemetry.where('ownerId').equals(this.userId).limit(500).toArray()
    if (tel.length) {
      const { error } = await this.sb.from('telemetry_events').upsert(
        tel.map((t) => ({
          client_id: t.clientId,
          user_id: this.userId,
          provider: t.provider,
          model: t.model,
          ttft_ms: t.ttftMs,
          total_ms: t.totalMs,
          output_tokens: t.outputTokens,
          tokens_per_sec: t.tokensPerSec,
          device_tier: t.deviceTier,
          device_kind: t.deviceKind,
          was_online: t.wasOnline,
          error: t.error,
          created_at: iso(t.createdAt),
        })),
        { onConflict: 'user_id,client_id', ignoreDuplicates: true },
      )
      if (error) throw error
      await this.db.telemetry.bulkDelete(tel.map((t) => t.clientId))
    }
  }
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message)
  return String(e)
}
