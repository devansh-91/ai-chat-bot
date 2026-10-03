import { setPresenceModel, track } from '../activity'
import type { TurnMetrics } from '../db'
import { createStore } from '../store'
import { findModel, ollamaSpec } from './catalog'
import { detectDevice, type DeviceProfile } from './device'
import { OllamaProvider } from './ollama'
import type { ChatMessage, GenerateOptions, LoadProgress, ModelSpec, Provider, ProviderId } from './types'

export type ModelStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface ModelState {
  status: ModelStatus
  spec: ModelSpec | null
  progress: LoadProgress | null
  error: string | null
  device: DeviceProfile | null
}

export const modelState = createStore<ModelState>({
  status: 'idle',
  spec: null,
  progress: null,
  error: null,
  device: null,
})

const SELECTED_KEY = 'shreyan.model'

export function getSelectedModelKey(): string | null {
  try {
    return localStorage.getItem(SELECTED_KEY)
  } catch {
    return null
  }
}

// WebLLM and wllama are imported lazily: they are large and only one is needed per device.
const providers = new Map<ProviderId, Provider>()
async function getProvider(id: ProviderId): Promise<Provider> {
  let p = providers.get(id)
  if (!p) {
    if (id === 'webllm') p = new (await import('./webllm')).WebLLMProvider()
    else if (id === 'wllama') p = new (await import('./wllama')).WllamaProvider()
    else p = new OllamaProvider()
    providers.set(id, p)
  }
  return p
}

let active: Provider | null = null
let loadSeq = 0

export async function initDevice(): Promise<DeviceProfile> {
  const device = await detectDevice()
  modelState.set((s) => ({ ...s, device }))
  setPresenceModel(modelState.get().spec?.modelId ?? null, device.tier)
  return device
}

/** Loads a model by catalog key (or "ollama:<name>"). Concurrent calls: the last one wins. */
export async function loadModel(key: string): Promise<void> {
  const spec = findModel(key) ?? (key.startsWith('ollama:') ? ollamaSpec(key.slice(7)) : undefined)
  if (!spec) throw new Error(`Unknown model ${key}`)
  const seq = ++loadSeq
  const startedAt = performance.now()
  modelState.set((s) => ({ ...s, status: 'loading', spec, progress: { fraction: 0, text: 'Starting…' }, error: null }))
  try {
    const provider = await getProvider(spec.provider)
    if (active && active !== provider) await active.unload()
    await provider.load(spec, (progress) => {
      if (seq === loadSeq) modelState.set((s) => ({ ...s, progress }))
    })
    if (seq !== loadSeq) return
    active = provider
    try {
      localStorage.setItem(SELECTED_KEY, key)
    } catch {
      // selection just won't persist
    }
    modelState.set((s) => ({ ...s, status: 'ready', progress: null }))
    setPresenceModel(spec.modelId)
    track('model_loaded', { model: spec.modelId, provider: spec.provider, ms: Math.round(performance.now() - startedAt) })
  } catch (e) {
    if (seq === loadSeq) {
      track('model_error', { model: spec.modelId, provider: spec.provider })
      modelState.set((s) => ({ ...s, status: 'error', progress: null, error: e instanceof Error ? e.message : String(e) }))
    }
    throw e
  }
}

/** The model a send should use when none is loaded: current, then last used, then the device's recommendation. */
export async function defaultModelKey(): Promise<string> {
  const s = modelState.get()
  return s.spec?.key ?? getSelectedModelKey() ?? (s.device ?? (await initDevice())).recommendedModelKey
}

/** Resolves once a model is ready, loading the default one if needed (waits for an in-flight load). */
export async function ensureModel(): Promise<void> {
  const s = modelState.get()
  if (s.status === 'ready') return
  if (s.status === 'loading') {
    await new Promise<void>((resolve, reject) => {
      const unsub = modelState.subscribe(() => {
        const { status, error } = modelState.get()
        if (status === 'loading') return
        unsub()
        if (status === 'ready') resolve()
        else reject(new Error(error ?? 'Model failed to load'))
      })
    })
    return
  }
  await loadModel(await defaultModelKey())
}

export interface TimedResult {
  text: string
  metrics: TurnMetrics
}

/**
 * Runs one generation and measures it. TTFT = request start → first streamed token,
 * tokens/sec is measured over the decode phase only (after the first token).
 */
export async function generate(messages: ChatMessage[], opts: GenerateOptions): Promise<TimedResult> {
  const { spec } = modelState.get()
  if (!active || !spec || modelState.get().status !== 'ready') throw new Error('No model loaded')
  const start = performance.now()
  let firstAt: number | null = null
  let chunks = 0
  const result = await active.generate(messages, {
    ...opts,
    onToken: (delta) => {
      firstAt ??= performance.now()
      chunks++
      opts.onToken?.(delta)
    },
  })
  const end = performance.now()
  const outputTokens = result.outputTokens ?? chunks
  const decodeSec = firstAt != null ? (end - firstAt) / 1000 : 0
  return {
    text: result.text,
    metrics: {
      provider: spec.provider,
      model: spec.modelId,
      ttftMs: firstAt != null ? Math.round(firstAt - start) : null,
      totalMs: Math.round(end - start),
      outputTokens,
      tokensPerSec: decodeSec > 0.05 && outputTokens > 1 ? Math.round(((outputTokens - 1) / decodeSec) * 10) / 10 : null,
    },
  }
}
