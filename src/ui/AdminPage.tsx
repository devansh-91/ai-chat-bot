import { useState } from 'react'
import { LATENCY_TARGET_MS, useAdmin, useAuth } from '../hooks'

const ms = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v)} ms`)

export function AdminPage() {
  const [hours, setHours] = useState(24)
  const a = useAdmin(hours)
  const me = useAuth()
  const o = a.overview.data
  return (
    <div className="page">
      <h2>Admin console</h2>
      {a.overview.error && <p className="bad">{a.overview.error}</p>}
      {o && (
        <p>
          Users {o.users} · admins {o.admins} · active 24h {o.active_24h} · conversations {o.conversations} · messages {o.messages}
          <br />
          <span className="meta">
            Purge cutoff {new Date(o.next_purge_cutoff).toLocaleString()} · last purge{' '}
            {o.last_purge ? new Date(o.last_purge.created_at).toLocaleString() : 'never'}
          </span>{' '}
          <button onClick={() => void a.runPurge()}>Run purge now</button>
        </p>
      )}

      <h3>
        Latency by model{' '}
        <select value={hours} onChange={(e) => setHours(+e.target.value)}>
          <option value={1}>1h</option>
          <option value={24}>24h</option>
          <option value={168}>7d</option>
        </select>
      </h3>
      <table>
        <thead>
          <tr><th>Model</th><th>Provider</th><th>Req</th><th>Err</th><th>TTFT p50</th><th>TTFT p95</th><th>Total p50</th><th>tok/s</th><th>&lt;{LATENCY_TARGET_MS}ms</th></tr>
        </thead>
        <tbody>
          {a.byModel.data?.map((r) => (
            <tr key={r.model + r.provider}>
              <td>{r.model}</td><td>{r.provider}</td><td>{r.requests}</td><td>{r.errors}</td>
              <td>{ms(r.ttft_p50)}</td><td>{ms(r.ttft_p95)}</td><td>{ms(r.total_p50)}</td>
              <td>{r.avg_tokens_per_sec?.toFixed(1) ?? '–'}</td>
              <td>{r.sub_800ms_ratio == null ? '–' : `${Math.round(r.sub_800ms_ratio * 100)}%`}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Timeline</h3>
      <table>
        <tbody>
          {a.series.data?.map((b) => (
            <tr key={b.bucket}>
              <td>{new Date(b.bucket).toLocaleTimeString()}</td>
              <td>{b.requests} req</td>
              <td>{b.active_users} users</td>
              <td>p50 {ms(b.ttft_p50)}</td>
              <td>p95 {ms(b.ttft_p95)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Users</h3>
      <table>
        <tbody>
          {a.users.data?.map((u) => (
            <tr key={u.id}>
              <td>{u.email}</td>
              <td>{u.role}</td>
              <td>{u.requests_24h} req/24h</td>
              <td>
                {u.id !== me.user?.id && (
                  <button onClick={() => void a.setRole(u.id, u.role === 'admin' ? 'user' : 'admin')}>
                    {u.role === 'admin' ? 'Demote' : 'Make admin'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Audit log</h3>
      <table>
        <tbody>
          {a.audit.data?.map((e) => (
            <tr key={e.id}>
              <td>{new Date(e.created_at).toLocaleString()}</td>
              <td>{e.action}</td>
              <td className="meta">{JSON.stringify(e.meta)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
