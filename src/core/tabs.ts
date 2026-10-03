import { db, type LocalDB } from './db'

/**
 * Open chat tabs, remembered per account in IndexedDB so they survive reloads. A tab disappears on
 * its own when its conversation is deleted or reaches the 15-day purge. Closing a tab only hides
 * it; the chat stays in history.
 */
export interface TabsState {
  open: string[]
  active: string | null
}

export const MAX_TABS = 12

const key = (ownerId: string) => `tabs:${ownerId}`

export async function getTabs(ownerId: string, database: LocalDB = db): Promise<TabsState> {
  const v = (await database.kv.get(key(ownerId)))?.value as TabsState | undefined
  return v ?? { open: [], active: null }
}

async function update(ownerId: string, fn: (t: TabsState) => TabsState, database: LocalDB = db): Promise<TabsState> {
  return database.transaction('rw', database.kv, async () => {
    const next = fn(await getTabs(ownerId, database))
    await database.kv.put({ key: key(ownerId), value: next })
    return next
  })
}

/** Opens (or focuses) a tab. The oldest tabs are dropped beyond MAX_TABS. */
export function openTab(ownerId: string, id: string, database: LocalDB = db): Promise<TabsState> {
  return update(ownerId, (t) => {
    const open = t.open.includes(id) ? t.open : [...t.open, id]
    return { open: open.slice(-MAX_TABS), active: id }
  }, database)
}

/** Closes a tab and focuses its neighbour (right, else left). Returns the new state. */
export function closeTab(ownerId: string, id: string, database: LocalDB = db): Promise<TabsState> {
  return update(ownerId, (t) => {
    const i = t.open.indexOf(id)
    if (i < 0) return t
    const open = t.open.filter((x) => x !== id)
    const active = t.active === id ? (open[i] ?? open[i - 1] ?? null) : t.active
    return { open, active }
  }, database)
}

/** Keeps only tabs whose conversations still exist (not deleted or purged). */
export function reconcileTabs(t: TabsState, existing: Set<string>): TabsState {
  const open = t.open.filter((id) => existing.has(id))
  const active = t.active && existing.has(t.active) ? t.active : (open.at(-1) ?? null)
  return { open, active }
}

/** Tabs follow the account: guest tabs move over on sign-in, like guest chats. */
export async function claimGuestTabs(guestId: string, userId: string, database: LocalDB = db): Promise<void> {
  const guest = await getTabs(guestId, database)
  if (!guest.open.length) return
  await update(userId, (t) => ({ open: [...new Set([...t.open, ...guest.open])].slice(-MAX_TABS), active: guest.active ?? t.active }), database)
  await database.kv.delete(key(guestId))
}
