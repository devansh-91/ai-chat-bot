import Dexie, { type EntityTable } from 'dexie'

export type Role = 'user' | 'assistant' | 'system'

/** Local mirror of public.conversations. Timestamps are epoch ms. */
export interface LocalConversation {
  id: string
  ownerId: string
  title: string | null
  persona: string
  createdAt: number
  updatedAt: number
  deletedAt: number | null
  /** 1 = has local changes not yet pushed to the cloud. */
  dirty: 0 | 1
}

export interface TurnMetrics {
  provider: string
  model: string
  ttftMs: number | null
  totalMs: number
  outputTokens: number
  tokensPerSec: number | null
}

export interface LocalMessage {
  id: string
  conversationId: string
  ownerId: string
  role: Role
  content: string
  model: string | null
  createdAt: number
  dirty: 0 | 1
  /** Only present on assistant messages generated on this device. Never synced. */
  metrics?: TurnMetrics
}

export interface PendingTelemetry {
  clientId: string
  ownerId: string
  provider: string
  model: string
  ttftMs: number | null
  totalMs: number
  outputTokens: number
  tokensPerSec: number | null
  deviceTier: string
  deviceKind: 'mobile' | 'desktop'
  wasOnline: boolean
  error: string | null
  createdAt: number
}

export interface PendingActivity {
  clientId: string
  ownerId: string
  kind: string
  meta: Record<string, string | number | boolean | null>
  deviceKind: 'mobile' | 'desktop'
  createdAt: number
}

export interface KV {
  key: string
  value: unknown
}

export class LocalDB extends Dexie {
  conversations!: EntityTable<LocalConversation, 'id'>
  messages!: EntityTable<LocalMessage, 'id'>
  telemetry!: EntityTable<PendingTelemetry, 'clientId'>
  activity!: EntityTable<PendingActivity, 'clientId'>
  kv!: EntityTable<KV, 'key'>

  constructor(name = 'shreyan-ai') {
    super(name)
    this.version(1).stores({
      conversations: 'id, ownerId, [ownerId+updatedAt], dirty, updatedAt',
      messages: 'id, conversationId, [conversationId+createdAt], ownerId, dirty, createdAt',
      telemetry: 'clientId, ownerId, createdAt',
      kv: 'key',
    })
    this.version(2).stores({
      activity: 'clientId, ownerId, createdAt',
    })
  }
}

export const db = new LocalDB()

export async function getKV<T>(key: string): Promise<T | undefined> {
  return (await db.kv.get(key))?.value as T | undefined
}

export async function setKV(key: string, value: unknown): Promise<void> {
  await db.kv.put({ key, value })
}
