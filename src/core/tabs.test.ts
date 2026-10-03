import { beforeEach, describe, expect, it } from 'vitest'
import { LocalDB } from './db'
import { claimGuestTabs, closeTab, getTabs, MAX_TABS, openTab, reconcileTabs } from './tabs'

let database: LocalDB
beforeEach(async () => {
  database = new LocalDB(`tabs-${crypto.randomUUID()}`)
  await database.open()
})

describe('tabs', () => {
  it('opens, focuses and remembers tabs per account', async () => {
    await openTab('u1', 'a', database)
    await openTab('u1', 'b', database)
    await openTab('u1', 'a', database) // focusing an open tab doesn't duplicate it
    expect(await getTabs('u1', database)).toEqual({ open: ['a', 'b'], active: 'a' })
    expect(await getTabs('u2', database)).toEqual({ open: [], active: null })
  })

  it('closing the active tab focuses its right neighbour, else the left', async () => {
    for (const id of ['a', 'b', 'c']) await openTab('u', id, database)
    await openTab('u', 'b', database)
    expect((await closeTab('u', 'b', database)).active).toBe('c')
    expect((await closeTab('u', 'c', database)).active).toBe('a')
    expect(await closeTab('u', 'a', database)).toEqual({ open: [], active: null })
  })

  it('closing a background tab keeps the active one', async () => {
    for (const id of ['a', 'b']) await openTab('u', id, database)
    expect(await closeTab('u', 'a', database)).toEqual({ open: ['b'], active: 'b' })
  })

  it(`keeps at most ${MAX_TABS} tabs`, async () => {
    for (let i = 0; i < MAX_TABS + 3; i++) await openTab('u', `t${i}`, database)
    const t = await getTabs('u', database)
    expect(t.open).toHaveLength(MAX_TABS)
    expect(t.open[0]).toBe('t3')
  })

  it('drops tabs whose chats were deleted or purged after 15 days', () => {
    expect(reconcileTabs({ open: ['a', 'gone', 'b'], active: 'gone' }, new Set(['a', 'b']))).toEqual({ open: ['a', 'b'], active: 'b' })
  })

  it('moves guest tabs to the account on sign-in', async () => {
    await openTab('guest', 'g1', database)
    await openTab('u', 'x', database)
    await claimGuestTabs('guest', 'u', database)
    expect(await getTabs('u', database)).toEqual({ open: ['x', 'g1'], active: 'g1' })
    expect(await getTabs('guest', database)).toEqual({ open: [], active: null })
  })
})
