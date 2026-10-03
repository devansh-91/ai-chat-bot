import { useModel } from '../hooks'

export function ModelPicker() {
  const m = useModel()
  const current = m.spec?.key ?? m.lastUsedKey ?? m.recommendedKey ?? ''
  return (
    <span className="model-picker">
      <select
        value={current}
        disabled={m.status === 'loading'}
        onChange={(e) => void m.load(e.target.value).catch(() => {})}
      >
        {!m.spec && <option value="">Choose a model…</option>}
        {m.available.map((s) => (
          <option key={s.key} value={s.key}>
            {s.label}
            {s.key === m.recommendedKey ? ' ★' : ''}
            {s.downloadMB ? ` · ${s.downloadMB} MB` : ''}
          </option>
        ))}
      </select>
      {m.status !== 'ready' && m.status !== 'loading' && current && (
        <button onClick={() => void m.load(current).catch(() => {})}>Load</button>
      )}
      {m.status === 'loading' && (
        <span className="meta">
          <progress value={m.progress?.fraction ?? undefined} max={1} /> {m.progress?.text.slice(0, 60)}
        </span>
      )}
      {m.status === 'error' && <span className="bad meta">{m.error}</span>}
      {m.device && <span className="pill" title={JSON.stringify(m.device)}>tier: {m.device.tier}</span>}
    </span>
  )
}
