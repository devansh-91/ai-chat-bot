import { describe, expect, it } from 'vitest'
import { computeStatus, describeActivity, normalizePage } from './activity'
import { applyPresence, expirePresence, sortLiveUsers, type LiveUser } from './admin'

const base = { generating: 0, listening: false, typingUntil: 0, hidden: false, page: '/', model: null, tier: null }

describe('presence status', () => {
  it('picks the most specific activity', () => {
    expect(computeStatus(base)).toBe('active')
    expect(computeStatus({ ...base, hidden: true })).toBe('idle')
    expect(computeStatus({ ...base, typingUntil: 2000 }, 1000)).toBe('typing')
    expect(computeStatus({ ...base, typingUntil: 500 }, 1000)).toBe('active')
    expect(computeStatus({ ...base, listening: true, typingUntil: 2000 }, 1000)).toBe('listening')
    expect(computeStatus({ ...base, generating: 1, listening: true, hidden: true })).toBe('generating')
  })
  it('strips conversation ids from pages', () => {
    expect(normalizePage('/c/8f3a2b1c-0000-4000-8000-000000000000')).toBe('/c/:id')
    expect(normalizePage('/admin')).toBe('/admin')
  })
})

describe('feed text', () => {
  it('describes events without content', () => {
    expect(describeActivity('reply', { model: 'qwen', total_ms: 1234.4, ttft_ms: 321, tps: 30 })).toBe(
      'got a reply from qwen in 1234 ms (first token 321 ms, 30 tok/s)',
    )
    expect(describeActivity('message_sent', { chars: 42, persona: 'tutor' })).toBe('sent a message (42 chars, tutor)')
    expect(describeActivity('mystery', {})).toBe('mystery')
  })
})

describe('live user list', () => {
  const user = (id: string, over: Partial<LiveUser> = {}): LiveUser => ({
    user_id: id, email: `${id}@x`, display_name: id, avatar_url: null, role: 'user', status: 'offline', page: null, model: null,
    device_kind: null, device_tier: null, updated_at: null, online: false, events_1h: 0, last_event: null, last_event_at: null, ...over,
  })
  const now = Date.parse('2026-10-03T12:00:00Z')

  it('applies a fresh presence heartbeat', () => {
    const out = applyPresence([user('a'), user('b')], {
      user_id: 'a', status: 'typing', page: '/c/:id', model: 'qwen', device_kind: 'mobile', device_tier: 'mid', updated_at: '2026-10-03T11:59:50Z',
    }, now)
    expect(out[0]).toMatchObject({ online: true, status: 'typing', device_kind: 'mobile' })
    expect(out[1].online).toBe(false)
  })
  it('treats an explicit offline or stale heartbeat as offline', () => {
    const row = { user_id: 'a', status: 'active', page: '/', model: null, device_kind: null, device_tier: null, updated_at: '2026-10-03T11:50:00Z' }
    expect(applyPresence([user('a')], row, now)[0].online).toBe(false)
    expect(applyPresence([user('a')], { ...row, status: 'offline', updated_at: '2026-10-03T11:59:59Z' }, now)[0].status).toBe('offline')
  })
  it('expires users whose heartbeat stopped', () => {
    const out = expirePresence([user('a', { online: true, status: 'active', updated_at: '2026-10-03T11:58:00Z' })], now)
    expect(out[0]).toMatchObject({ online: false, status: 'offline' })
  })
  it('sorts online users first, then most recent', () => {
    const out = sortLiveUsers([
      user('old', { updated_at: '2026-10-01T00:00:00Z' }),
      user('on', { online: true, updated_at: '2026-10-02T00:00:00Z' }),
      user('recent', { updated_at: '2026-10-03T00:00:00Z' }),
    ])
    expect(out.map((u) => u.user_id)).toEqual(['on', 'recent', 'old'])
  })
})
