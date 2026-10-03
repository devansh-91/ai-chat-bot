import { LATENCY_TARGET_MS } from './config'
import { db, type TurnMetrics } from './db'
import type { DeviceProfile } from './llm/device'
import { createStore } from './store'

export interface TurnSample extends TurnMetrics {
  at: number
  error: string | null
}

export interface TelemetryStats {
  count: number
  errors: number
  ttftP50: number | null
  ttftP95: number | null
  totalP50: number | null
  totalP95: number | null
  avgTokensPerSec: number | null
  /** Share of successful turns with first token under LATENCY_TARGET_MS. */
  underTargetRatio: number | null
}

/** Linear-interpolated percentile (same method as Postgres percentile_cont). */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

export function summarize(samples: TurnSample[]): TelemetryStats {
  const ok = samples.filter((s) => !s.error)
  const ttft = ok.map((s) => s.ttftMs).filter((v): v is number => v != null)
  const total = ok.map((s) => s.totalMs)
  const tps = ok.map((s) => s.tokensPerSec).filter((v): v is number => v != null)
  return {
    count: samples.length,
    errors: samples.length - ok.length,
    ttftP50: percentile(ttft, 0.5),
    ttftP95: percentile(ttft, 0.95),
    totalP50: percentile(total, 0.5),
    totalP95: percentile(total, 0.95),
    avgTokensPerSec: tps.length ? tps.reduce((a, b) => a + b, 0) / tps.length : null,
    underTargetRatio: ttft.length ? ttft.filter((v) => v < LATENCY_TARGET_MS).length / ttft.length : null,
  }
}

const RING_SIZE = 100

/** Live samples from this device for the HUD (most recent last). */
export const recentTurns = createStore<TurnSample[]>([])

export async function recordTurn(
  metrics: TurnMetrics,
  ctx: { ownerId: string; device: DeviceProfile | null; error?: string | null },
): Promise<void> {
  const sample: TurnSample = { ...metrics, at: Date.now(), error: ctx.error ?? null }
  recentTurns.set((prev) => [...prev, sample].slice(-RING_SIZE))
  // Queued locally; the sync engine uploads it when signed in and online.
  await db.telemetry.add({
    clientId: crypto.randomUUID(),
    ownerId: ctx.ownerId,
    provider: metrics.provider,
    model: metrics.model,
    ttftMs: metrics.ttftMs,
    totalMs: metrics.totalMs,
    outputTokens: metrics.outputTokens,
    tokensPerSec: metrics.tokensPerSec,
    deviceTier: ctx.device?.tier ?? 'unknown',
    deviceKind: ctx.device?.mobile ? 'mobile' : 'desktop',
    wasOnline: navigator.onLine,
    error: sample.error,
    createdAt: sample.at,
  })
}
