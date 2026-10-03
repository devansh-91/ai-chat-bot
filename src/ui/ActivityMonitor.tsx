import { useState } from 'react'
import { describeActivity, useLiveActivity } from '../hooks'

const ago = (iso: string | null) => {
  if (!iso) return 'never'
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

const STATUS_ICON: Record<string, string> = {
  generating: '🧠',
  typing: '⌨️',
  listening: '🎤',
  active: '🟢',
  idle: '🟡',
  offline: '⚪',
}

const KINDS = ['message_sent', 'reply', 'reply_error', 'model_loaded', 'voice_input', 'chat_created', 'session_start', 'sign_in', 'page_view']

/** Admin: who is on Shreyan.ai right now and what they are doing (metadata only, never message text). */
export function ActivityMonitor() {
  const [userId, setUserId] = useState<string | null>(null)
  const [kind, setKind] = useState<string | null>(null)
  const [hours, setHours] = useState(24)
  const a = useLiveActivity({ windowHours: hours, userId, kind })
  const name = (u: { display_name: string | null; email: string | null }) => u.display_name ?? u.email ?? 'unknown'

  return (
    <section>
      <h3>
        Live activity <span className={`pill ${a.live ? 'ok' : 'warn'}`}>{a.live ? '● live' : 'connecting…'}</span>
      </h3>
      {a.error && <p className="bad">{a.error}</p>}
      {a.stats && (
        <p>
          <b>{a.stats.online_now}</b> online now · {a.stats.active_users} active in {hours}h · messages {a.stats.by_kind.message_sent ?? 0} ·
          replies {a.stats.by_kind.reply ?? 0} · errors {a.stats.by_kind.reply_error ?? 0} · voice {a.stats.by_kind.voice_input ?? 0}
          <br />
          <span className="meta">
            devices: {Object.entries(a.stats.by_device).map(([k, v]) => `${k} ${v}`).join(', ') || '–'} · top models:{' '}
            {a.stats.top_models.map((m) => `${m.model} (${m.replies})`).join(', ') || '–'} · personas:{' '}
            {a.stats.top_personas.map((p) => `${p.persona} (${p.messages})`).join(', ') || '–'}
          </span>
        </p>
      )}

      <table>
        <thead>
          <tr><th>User</th><th>Now</th><th>Where</th><th>Model</th><th>Device</th><th>Last action</th><th>1h</th><th /></tr>
        </thead>
        <tbody>
          {a.users.map((u) => (
            <tr key={u.user_id} style={{ opacity: u.online ? 1 : 0.55 }}>
              <td>{name(u)}{u.role === 'admin' && ' (admin)'}</td>
              <td>{STATUS_ICON[u.status] ?? ''} {u.status}{!u.online && u.updated_at ? ` · ${ago(u.updated_at)}` : ''}</td>
              <td>{u.online ? u.page ?? '–' : '–'}</td>
              <td className="meta">{u.model ?? '–'}</td>
              <td className="meta">{u.device_kind ?? '–'}{u.device_tier ? ` · ${u.device_tier}` : ''}</td>
              <td className="meta">{u.last_event ? `${u.last_event.replace('_', ' ')} · ${ago(u.last_event_at)}` : '–'}</td>
              <td>{u.events_1h}</td>
              <td>
                <button onClick={() => setUserId(userId === u.user_id ? null : u.user_id)}>
                  {userId === u.user_id ? 'Show all' : 'Only this user'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4>
        Feed{' '}
        <select value={kind ?? ''} onChange={(e) => setKind(e.target.value || null)}>
          <option value="">all events</option>
          {KINDS.map((k) => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}
        </select>{' '}
        <select value={hours} onChange={(e) => setHours(+e.target.value)}>
          <option value={1}>1h</option>
          <option value={24}>24h</option>
          <option value={168}>7d</option>
        </select>
        {userId && <> · filtered to {name(a.users.find((u) => u.user_id === userId) ?? { display_name: null, email: null })}</>}
      </h4>
      <div style={{ maxHeight: 360, overflow: 'auto' }}>
        {a.feed.map((e) => (
          <div key={e.id} className="meta" style={{ padding: '3px 0' }}>
            <span title={e.created_at}>{new Date(e.created_at).toLocaleTimeString()}</span> · <b>{name(e)}</b>{' '}
            {describeActivity(e.kind, e.meta)} {e.device_kind === 'mobile' ? '📱' : '💻'}
          </div>
        ))}
        {!a.feed.length && <p className="meta">No activity yet.</p>}
      </div>
      <p className="meta">Admins see activity metadata only. Message text is never collected.</p>
    </section>
  )
}
