import { RETENTION_MS } from './config'
import { db, type LocalDB } from './db'

export interface PurgeResult {
  conversations: number
  messages: number
  telemetry: number
}

/**
 * Local half of the 15-day lifecycle (the server runs the same rule via pg_cron).
 * Messages expire 15 days after creation; conversations expire after 15 days without activity.
 */
export async function purgeLocal(now = Date.now(), database: LocalDB = db): Promise<PurgeResult> {
  const cutoff = now - RETENTION_MS
  return database.transaction('rw', [database.conversations, database.messages, database.telemetry, database.activity], async () => {
    const messages = await database.messages.where('createdAt').below(cutoff).delete()
    const expired = await database.conversations.where('updatedAt').below(cutoff).primaryKeys()
    await database.messages.where('conversationId').anyOf(expired).delete()
    await database.conversations.bulkDelete(expired)
    const telemetry = await database.telemetry.where('createdAt').below(cutoff).delete()
    await database.activity.where('createdAt').below(cutoff).delete()
    return { conversations: expired.length, messages, telemetry }
  })
}

/** Milliseconds until a conversation last active at `updatedAt` is purged. */
export function expiresInMs(updatedAt: number, now = Date.now()): number {
  return Math.max(0, updatedAt + RETENTION_MS - now)
}

let timer: ReturnType<typeof setInterval> | null = null

export function startLocalPurgeSchedule(): void {
  if (timer) return
  void purgeLocal()
  timer = setInterval(() => void purgeLocal(), 60 * 60 * 1000)
}
