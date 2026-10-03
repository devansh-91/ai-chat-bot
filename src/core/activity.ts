import type { SupabaseClient } from '@supabase/supabase-js'
import { GUEST_OWNER } from './config'
import { db } from './db'
import { isMobileUA } from './llm/device'

/**
 * Activity reporting for the admin monitor. Privacy rule: metadata only (what kind of thing happened,
 * which model, how fast, which device). Message text is never recorded; the server also rejects
 * oversized metadata, so it cannot be smuggled in.
 */

export type ActivityKind =
  | 'session_start' | 'sign_in' | 'sign_out'
  | 'chat_created' | 'chat_deleted' | 'persona_changed'
  | 'message_sent' | 'reply' | 'reply_error' | 'reply_stopped'
  | 'model_loaded' | 'model_error'
  | 'voice_input' | 'voice_output' | 'page_view'

export type PresenceStatus = 'active' | 'idle' | 'typing' | 'generating' | 'listening' | 'offline'

export type ActivityMeta = Record<string, string | number | boolean | null>

/** Set by auth: who owns new events, and how to trigger an upload. */
export const activityContext = {
  ownerId: GUEST_OWNER,
  onQueued: () => {},
}

const deviceKind = (): 'mobile' | 'desktop' =>
  typeof navigator !== 'undefined' && isMobileUA(navigator.userAgent) ? 'mobile' : 'desktop'

/** Queues an event locally; the sync engine uploads it when signed in and online. */
export function track(kind: ActivityKind, meta: ActivityMeta = {}): Promise<void> {
  return db.activity
    .add({
      clientId: crypto.randomUUID(),
      ownerId: activityContext.ownerId,
      kind,
      meta,
      deviceKind: deviceKind(),
      createdAt: Date.now(),
    })
    .then(() => activityContext.onQueued())
    .catch(() => {})
}

/** Normalizes a route so ids never leave the device: /c/8f3a… -> /c/:id */
export function normalizePage(pathname: string): string {
  return pathname.replace(/\/c\/[^/]+/, '/c/:id').slice(0, 64) || '/'
}

// ───────────────────────── presence ─────────────────────────

interface PresenceInputs {
  generating: number
  listening: boolean
  typingUntil: number
  hidden: boolean
  page: string
  model: string | null
  tier: string | null
}

const inputs: PresenceInputs = { generating: 0, listening: false, typingUntil: 0, hidden: false, page: '/', model: null, tier: null }

/** Most specific thing the user is doing right now. */
export function computeStatus(i: PresenceInputs, now = Date.now()): PresenceStatus {
  if (i.generating > 0) return 'generating'
  if (i.listening) return 'listening'
  if (i.typingUntil > now) return 'typing'
  return i.hidden ? 'idle' : 'active'
}

let reporter: PresenceReporter | null = null

export function setGenerating(on: boolean): void {
  inputs.generating = Math.max(0, inputs.generating + (on ? 1 : -1))
  reporter?.changed()
}
export function setListening(on: boolean): void {
  inputs.listening = on
  reporter?.changed()
}
export function setPresencePage(page: string): void {
  inputs.page = normalizePage(page)
  reporter?.changed()
}
export function setPresenceModel(model: string | null, tier?: string | null): void {
  inputs.model = model
  if (tier !== undefined) inputs.tier = tier
  reporter?.changed()
}

let typingTimer: ReturnType<typeof setTimeout> | null = null
/** Call on composer input; "typing" clears itself a few seconds after the last keystroke. */
export function reportTyping(): void {
  const wasTyping = inputs.typingUntil > Date.now()
  inputs.typingUntil = Date.now() + 4000
  if (!wasTyping) reporter?.changed()
  if (typingTimer) clearTimeout(typingTimer)
  typingTimer = setTimeout(() => reporter?.changed(), 4100)
}

const HEARTBEAT_MS = 30_000

/** Keeps public.user_presence up to date for one signed-in user. */
export class PresenceReporter {
  private timer: ReturnType<typeof setInterval> | null = null
  private lastSent: string | null = null
  private pending: ReturnType<typeof setTimeout> | null = null
  private readonly sb: SupabaseClient
  private readonly userId: string

  constructor(sb: SupabaseClient, userId: string) {
    this.sb = sb
    this.userId = userId
  }

  start(): void {
    reporter = this
    inputs.hidden = document.visibilityState === 'hidden'
    document.addEventListener('visibilitychange', this.onVisibility)
    window.addEventListener('pagehide', this.onPageHide)
    window.addEventListener('online', this.onOnline)
    this.timer = setInterval(() => void this.send(true), HEARTBEAT_MS)
    void this.send(true)
  }

  async stop(): Promise<void> {
    if (reporter === this) reporter = null
    document.removeEventListener('visibilitychange', this.onVisibility)
    window.removeEventListener('pagehide', this.onPageHide)
    window.removeEventListener('online', this.onOnline)
    if (this.timer) clearInterval(this.timer)
    if (this.pending) clearTimeout(this.pending)
    await this.send(true, 'offline')
  }

  /** Something changed: send soon (coalesces bursts). */
  changed(): void {
    if (this.pending) return
    this.pending = setTimeout(() => {
      this.pending = null
      void this.send(false)
    }, 300)
  }

  private onVisibility = () => {
    inputs.hidden = document.visibilityState === 'hidden'
    this.changed()
  }
  private onPageHide = () => void this.send(true, 'offline')
  private onOnline = () => void this.send(true)

  private async send(force: boolean, override?: PresenceStatus): Promise<void> {
    if (!navigator.onLine) return
    const row = {
      user_id: this.userId,
      status: override ?? computeStatus(inputs),
      page: inputs.page,
      model: inputs.model,
      device_kind: deviceKind(),
      device_tier: inputs.tier,
    }
    const key = JSON.stringify(row)
    if (!force && key === this.lastSent) return
    this.lastSent = key
    const { error } = await this.sb.from('user_presence').upsert(row, { onConflict: 'user_id' })
    if (error) this.lastSent = null
  }
}

// ───────────────────────── admin feed formatting ─────────────────────────

const ms = (v: unknown) => (typeof v === 'number' ? `${Math.round(v)} ms` : '')

/** One human-readable line per event, for the admin feed. */
export function describeActivity(kind: string, meta: Record<string, unknown>): string {
  switch (kind) {
    case 'session_start': return `opened the app${meta.installed ? ' (installed app)' : ''}`
    case 'sign_in': return 'signed in'
    case 'sign_out': return 'signed out'
    case 'chat_created': return `started a new chat${meta.persona ? ` (${meta.persona})` : ''}`
    case 'chat_deleted': return 'deleted a chat'
    case 'persona_changed': return `switched persona to ${meta.persona}`
    case 'message_sent': return `sent a message (${meta.chars ?? '?'} chars${meta.persona ? `, ${meta.persona}` : ''}${meta.offline ? ', offline' : ''})`
    case 'reply': return `got a reply from ${meta.model} in ${ms(meta.total_ms)} (first token ${ms(meta.ttft_ms)}${meta.tps ? `, ${meta.tps} tok/s` : ''})`
    case 'reply_error': return `reply failed on ${meta.model}: ${meta.error}`
    case 'reply_stopped': return `stopped a reply from ${meta.model}`
    case 'model_loaded': return `loaded ${meta.model} (${meta.provider}) in ${typeof meta.ms === 'number' ? (meta.ms / 1000).toFixed(1) + ' s' : '?'}`
    case 'model_error': return `failed to load ${meta.model}`
    case 'voice_input': return `used voice input (${meta.engine})`
    case 'voice_output': return 'listened to a reply'
    case 'page_view': return `opened ${meta.page}`
    default: return kind
  }
}
