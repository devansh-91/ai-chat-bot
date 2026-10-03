import { useTelemetryHud } from '../hooks'

const fmt = (v: number | null) => (v == null ? '–' : Math.round(v))

export function TelemetryHud() {
  const { last, stats, targetMs } = useTelemetryHud()
  if (!last) return <span className="pill meta">HUD: no data yet</span>
  const cls = last.ttftMs == null ? 'bad' : last.ttftMs < targetMs ? 'ok' : 'warn'
  return (
    <span className="pill" title={`p95 ${fmt(stats.ttftP95)} ms · ${stats.count} turns`}>
      <span className={cls}>TTFT {fmt(last.ttftMs)} ms</span> · {last.tokensPerSec ?? '–'} tok/s · p50 {fmt(stats.ttftP50)} ms ·{' '}
      {stats.underTargetRatio == null ? '–' : Math.round(stats.underTargetRatio * 100)}% &lt;{targetMs}ms
    </span>
  )
}
