import { beforeEach, describe, expect, it } from 'vitest'
import { RETENTION_MS } from './config'
import { LocalDB } from './db'
import { purgeLocal } from './privacy'
import { claimGuestData, mergeConversation, mergeMessage, wipeUserData, type ConversationRow, type MessageRow } from './sync'

let database: LocalDB
const U = 'user-1'

const convRow = (over: Partial<ConversationRow> = {}): ConversationRow => ({
  id: 'c1',
  user_id: U,
  title: 'Server title',
  persona: 'assistant',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-02T00:00:00Z',
  deleted_at: null,
  server_updated_at: '2026-10-02T00:00:01Z',
  ...over,
})

const msgRow = (over: Partial<MessageRow> = {}): MessageRow => ({
  id: 'm1',
  conversation_id: 'c1',
  user_id: U,
  role: 'user',
  content: 'hi',
  model: null,
  created_at: '2026-10-02T00:00:00Z',
  server_updated_at: '2026-10-02T00:00:01Z',
  ...over,
})

beforeEach(async () => {
  database = new LocalDB(`test-${crypto.randomUUID()}`)
  await database.open()
})

describe('sync merges', () => {
  it('inserts remote conversations and messages', async () => {
    await mergeConversation(convRow(), database)
    await mergeMessage(msgRow(), database)
    expect((await database.conversations.get('c1'))?.title).toBe('Server title')
    expect(await database.messages.count()).toBe(1)
  })

  it('keeps a newer unsynced local edit (last write wins)', async () => {
    await database.conversations.put({
      id: 'c1', ownerId: U, title: 'Local newer', persona: 'assistant',
      createdAt: Date.parse('2026-10-01T00:00:00Z'), updatedAt: Date.parse('2026-10-03T00:00:00Z'), deletedAt: null, dirty: 1,
    })
    await mergeConversation(convRow(), database)
    expect((await database.conversations.get('c1'))?.title).toBe('Local newer')
  })

  it('applies a remote edit over an older local one', async () => {
    await database.conversations.put({
      id: 'c1', ownerId: U, title: 'Local older', persona: 'assistant',
      createdAt: 0, updatedAt: Date.parse('2026-10-01T00:00:00Z'), deletedAt: null, dirty: 1,
    })
    await mergeConversation(convRow(), database)
    const c = await database.conversations.get('c1')
    expect(c?.title).toBe('Server title')
    expect(c?.dirty).toBe(0)
  })

  it('remote deletion wipes local messages and leaves a tombstone', async () => {
    await mergeConversation(convRow(), database)
    await mergeMessage(msgRow(), database)
    await mergeConversation(convRow({ deleted_at: '2026-10-03T00:00:00Z', title: null }), database)
    expect(await database.messages.count()).toBe(0)
    expect((await database.conversations.get('c1'))?.deletedAt).not.toBeNull()
    // late-arriving message for a deleted conversation is ignored
    await mergeMessage(msgRow({ id: 'm2' }), database)
    expect(await database.messages.count()).toBe(0)
  })

  it('a local deletion is not undone by a stale remote row', async () => {
    await database.conversations.put({ id: 'c1', ownerId: U, title: null, persona: 'assistant', createdAt: 0, updatedAt: 1, deletedAt: 1, dirty: 1 })
    await mergeConversation(convRow(), database)
    expect((await database.conversations.get('c1'))?.deletedAt).toBe(1)
  })

  it('merging the same message twice is idempotent and clears dirty', async () => {
    await mergeConversation(convRow(), database)
    await database.messages.put({ id: 'm1', conversationId: 'c1', ownerId: U, role: 'user', content: 'hi', model: null, createdAt: 1, dirty: 1 })
    await mergeMessage(msgRow(), database)
    await mergeMessage(msgRow(), database)
    expect(await database.messages.count()).toBe(1)
    expect((await database.messages.get('m1'))?.dirty).toBe(0)
  })
})

describe('account handover', () => {
  it('claims guest data on sign-in and wipes it on sign-out', async () => {
    await database.conversations.put({ id: 'g1', ownerId: 'guest', title: 't', persona: 'assistant', createdAt: 1, updatedAt: 1, deletedAt: null, dirty: 1 })
    await database.messages.put({ id: 'gm', conversationId: 'g1', ownerId: 'guest', role: 'user', content: 'x', model: null, createdAt: 1, dirty: 1 })
    await database.activity.put({ clientId: 'ga', ownerId: 'guest', kind: 'chat_created', meta: {}, deviceKind: 'desktop', createdAt: 1 })
    await claimGuestData('guest', U, database)
    expect((await database.activity.get('ga'))?.ownerId).toBe(U)
    expect((await database.conversations.get('g1'))?.ownerId).toBe(U)
    expect((await database.messages.get('gm'))?.ownerId).toBe(U)
    await wipeUserData(U, database)
    expect(await database.conversations.count()).toBe(0)
    expect(await database.messages.count()).toBe(0)
    expect(await database.activity.count()).toBe(0)
  })
})

describe('15-day local purge', () => {
  it('removes expired data and keeps fresh data', async () => {
    const now = Date.parse('2026-10-20T00:00:00Z')
    const old = now - RETENTION_MS - 1000
    await database.conversations.bulkPut([
      { id: 'old', ownerId: U, title: 'old', persona: 'assistant', createdAt: old, updatedAt: old, deletedAt: null, dirty: 0 },
      { id: 'new', ownerId: U, title: 'new', persona: 'assistant', createdAt: old, updatedAt: now, deletedAt: null, dirty: 0 },
    ])
    await database.messages.bulkPut([
      { id: 'a', conversationId: 'old', ownerId: U, role: 'user', content: 'x', model: null, createdAt: now, dirty: 0 },
      { id: 'b', conversationId: 'new', ownerId: U, role: 'user', content: 'x', model: null, createdAt: old, dirty: 0 },
      { id: 'c', conversationId: 'new', ownerId: U, role: 'user', content: 'x', model: null, createdAt: now, dirty: 0 },
    ])
    await database.activity.bulkPut([
      { clientId: 'old-act', ownerId: U, kind: 'reply', meta: {}, deviceKind: 'mobile', createdAt: old },
      { clientId: 'new-act', ownerId: U, kind: 'reply', meta: {}, deviceKind: 'mobile', createdAt: now },
    ])
    const r = await purgeLocal(now, database)
    expect(await database.activity.toCollection().primaryKeys()).toEqual(['new-act'])
    expect(r.conversations).toBe(1)
    expect(await database.conversations.toCollection().primaryKeys()).toEqual(['new'])
    expect(await database.messages.toCollection().primaryKeys()).toEqual(['c'])
  })
})
